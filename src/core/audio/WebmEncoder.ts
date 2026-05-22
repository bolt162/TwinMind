/**
 * WebmEncoder — converts a raw 16 kHz mono int16 PCM file to a WebM/Opus
 * file via the bundled `ffmpeg-static` binary.
 *
 * Invocation shape (matches V1's effective bitrate/codec):
 *   ffmpeg -hide_banner -loglevel error -y
 *          -f s16le -ar 16000 -ac 1 -i <pcmPath>
 *          -c:a libopus -b:a 32k -application voip
 *          -f webm <webmPath>
 *
 * `-application voip` tells libopus to optimize for speech (V1's MediaRecorder
 * does the same in browser defaults). 32 kbps mono Opus is roughly 8× smaller
 * than raw 16 kHz int16 PCM, matching V1's wire-format file sizes.
 *
 * Path resolution: `ffmpeg-static` is listed in electron-builder.json's
 * asarUnpack, but `require('ffmpeg-static')` still returns the in-asar path
 * because the require cache resolves against the JS module location. We swap
 * `app.asar/` → `app.asar.unpacked/` exactly like
 * `src/platform/audioteeBinaryPath.ts` does for the audiotee binary —
 * spawn() can't exec a file inside an asar archive.
 *
 * Failure taxonomy (typed via WebmEncodeError.kind):
 *   - 'spawn'        — ffmpeg never started (binary missing, ENOENT, EACCES)
 *   - 'nonzero_exit' — ffmpeg ran and returned non-zero
 *   - 'timeout'      — ffmpeg ran but exceeded the wall-clock cap
 *
 * Callers (ChunkWriter, RecoveryService) treat all three the same way: leave
 * the source `.pcm` file in place; recovery picks it up next launch.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Bitrate target for libopus. 32 kbps mono ≈ V1's MediaRecorder default. */
const DEFAULT_BITRATE = '32k';
/**
 * Floor for the per-call wall-clock cap. Covers ffmpeg's macOS spawn
 * overhead (~150-300 ms) + libopus's per-call setup, regardless of how
 * tiny the input is.
 */
const BASE_TIMEOUT_MS = 10_000;
/**
 * Extra budget per second of audio. libopus speech encodes at roughly
 * 20-50× realtime; 100 ms/audio-sec gives a 2-5× safety margin which
 * holds even on Intel Macs and battery-throttled M-series under load.
 * For a 5-min chunk that's 30 s of headroom on top of BASE_TIMEOUT_MS.
 */
const TIMEOUT_PER_AUDIO_SECOND_MS = 100;
/** Raw int16 mono 16 kHz: 32 000 bytes per second of audio. */
const PCM_BYTES_PER_SECOND = 32_000;

const ASAR_SEGMENT = `${path.sep}app.asar${path.sep}`;
const UNPACKED_SEGMENT = `${path.sep}app.asar.unpacked${path.sep}`;

export type WebmEncodeErrorKind = 'spawn' | 'nonzero_exit' | 'timeout';

export class WebmEncodeError extends Error {
  constructor(
    public readonly kind: WebmEncodeErrorKind,
    message: string,
    public readonly stderr?: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WebmEncodeError';
  }
}

export interface WebmEncoderOptions {
  /** Override the ffmpeg path (tests). Defaults to ffmpeg-static. */
  readonly ffmpegPath?: string;
  /** libopus bitrate string passed as `-b:a`. Default `32k`. */
  readonly bitrate?: string;
  /**
   * Fixed wall-clock cap per encode (ms). When set, used verbatim — useful
   * for tests that need a deterministic abort window. When omitted, the
   * timeout scales with input audio duration: BASE_TIMEOUT_MS +
   * audio-seconds × TIMEOUT_PER_AUDIO_SECOND_MS. A 30 s meeting chunk gets
   * ~13 s; a 5-min dictation chunk gets ~40 s — wide enough to absorb
   * encoder slowdowns on older hardware without prematurely killing
   * ffmpeg.
   */
  readonly timeoutMs?: number;
}

/**
 * Resolve the on-disk ffmpeg binary path. Returns null if `ffmpeg-static`
 * isn't installed for this platform (e.g., running tests on an unsupported
 * arch). Callers should treat null as a hard configuration error at the
 * composition root, not silently degrade.
 */
export function resolveFfmpegPath(): string | null {
  let resolved: string | null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    resolved = require('ffmpeg-static') as string | null;
  } catch {
    return null;
  }
  if (!resolved) return null;
  // asarUnpack copies the binary to `app.asar.unpacked/` at build time;
  // spawn() can't exec inside the archive. Same fix audiotee uses.
  return resolved.includes(ASAR_SEGMENT)
    ? resolved.replace(ASAR_SEGMENT, UNPACKED_SEGMENT)
    : resolved;
}

export class WebmEncoder {
  private readonly ffmpegPath: string;
  private readonly bitrate: string;
  /** Explicit override from opts.timeoutMs; null means "scale per encode". */
  private readonly timeoutMsOverride: number | null;

  constructor(opts: WebmEncoderOptions = {}) {
    const p = opts.ffmpegPath ?? resolveFfmpegPath();
    if (!p) {
      throw new Error(
        'WebmEncoder: ffmpeg-static unavailable. Check that ffmpeg-static is installed and supported on this platform.',
      );
    }
    this.ffmpegPath = p;
    this.bitrate = opts.bitrate ?? DEFAULT_BITRATE;
    this.timeoutMsOverride = opts.timeoutMs ?? null;
  }

  /**
   * Compute the per-call wall-clock cap. Explicit override wins; otherwise
   * derive audio duration from the PCM file size (16 kHz mono int16 =
   * fixed 32 000 bytes/sec) and add a per-audio-second buffer on top of
   * BASE_TIMEOUT_MS. If stat fails (input doesn't exist), fall back to
   * the base — ffmpeg will fail with nonzero_exit shortly anyway, no
   * point waiting longer.
   */
  private computeTimeoutMs(pcmPath: string): number {
    if (this.timeoutMsOverride !== null) return this.timeoutMsOverride;
    let audioSec = 0;
    try {
      audioSec = fs.statSync(pcmPath).size / PCM_BYTES_PER_SECOND;
    } catch {
      // Input missing; let ffmpeg report the real error. Base timeout
      // is plenty for that path.
    }
    return BASE_TIMEOUT_MS + Math.ceil(audioSec * TIMEOUT_PER_AUDIO_SECOND_MS);
  }

  /**
   * Encode `pcmPath` (raw s16le 16 kHz mono) to `webmPath` (WebM/Opus).
   * Resolves to the byte count of the produced WebM. Rejects with
   * `WebmEncodeError` on any failure; callers should leave the source
   * `.pcm` file untouched so recovery can retry next launch.
   */
  encode(pcmPath: string, webmPath: string): Promise<{ bytes: number }> {
    const timeoutMs = this.computeTimeoutMs(pcmPath);
    return new Promise((resolve, reject) => {
      const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-f', 's16le',
        '-ar', '16000',
        '-ac', '1',
        '-i', pcmPath,
        '-c:a', 'libopus',
        '-b:a', this.bitrate,
        '-application', 'voip',
        // Encoder-side analysis depth (0=fastest, 10=highest quality).
        // libopus's complexity knob does NOT change bitrate, codec mode,
        // or phonetic content — only psychoacoustic-model search depth.
        // Since we send to ASR (Whisper-class) and not human ears,
        // complexity 0 is appropriate: ~2× faster encode, ~7% larger
        // output (real speech: still tiny). Bench at 5 min random PCM:
        // default complexity 10 = 5.6 s wall; complexity 0 = 2.7 s wall.
        '-compression_level', '0',
        '-f', 'webm',
        webmPath,
      ];

      let child;
      try {
        child = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (cause) {
        reject(new WebmEncodeError('spawn', `ffmpeg spawn failed: ${describeError(cause)}`, undefined, cause));
        return;
      }

      let stderr = '';
      let settled = false;

      const onStderr = (chunk: Buffer): void => {
        stderr += chunk.toString();
        // Keep stderr bounded so a chatty error doesn't OOM us.
        if (stderr.length > 4_096) stderr = stderr.slice(-4_096);
      };
      child.stderr?.on('data', onStderr);

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        // Best-effort cleanup of a half-written WebM.
        try { fs.unlinkSync(webmPath); } catch { /* best-effort */ }
        reject(new WebmEncodeError('timeout', `ffmpeg exceeded ${timeoutMs} ms`, stderr));
      }, timeoutMs);

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new WebmEncodeError('spawn', `ffmpeg error: ${err.message}`, stderr, err));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          // Don't leave a partial WebM on disk if encoding failed.
          try { fs.unlinkSync(webmPath); } catch { /* best-effort */ }
          reject(new WebmEncodeError('nonzero_exit', `ffmpeg exited ${code}`, stderr));
          return;
        }
        let bytes: number;
        try {
          bytes = fs.statSync(webmPath).size;
        } catch (cause) {
          reject(new WebmEncodeError('nonzero_exit', 'ffmpeg exited 0 but output missing', stderr, cause));
          return;
        }
        resolve({ bytes });
      });
    });
  }
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'unknown error';
}
