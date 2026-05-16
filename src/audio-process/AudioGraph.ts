/**
 * AudioGraph — wires capture sources → mixer → outbound PCM messages.
 *
 * Architecture: §7.3 (capture topology), §7.5 (meeting mode pre-mix),
 * §7.4 (dictation = mic-only, no system stream), §7.11 (VAD accumulator
 * lives inside the mixer).
 *
 * Lifecycle (driven by MainToAudio messages):
 *   start_session   → connect capture sources, begin emitting `pcm_frame`s
 *   open_chunk      → reset VAD stats, optionally prepend overlap tail
 *   close_chunk     → drain queues, emit `chunk_closed` with sum-of-squares
 *   stop_session    → tear everything down
 *
 * The graph is intentionally synchronous: every capture frame triggers a pump,
 * and pumping produces zero or one output frame. There is no internal timer —
 * the capture sources' own timers drive the schedule.
 */

import { Mixer, DEFAULT_MIXER_CONFIG, type MixerConfig } from './Mixer';
import { SoftwareAgc } from './SoftwareAgc';
import type { ICapture, IMicCapture, ISystemAudioCapture } from './IMicCapture';
import type {
  AudioToMain,
  CloseChunkMsg,
  OpenChunkMsg,
  StartSessionMsg,
} from './protocol';

/**
 * Callback used by the graph to send messages back to main. The transferList
 * is unknown[] because the actual MessagePort shape varies between Electron
 * utilityProcess and worker_threads; both accept ArrayBuffer in this list.
 */
export type SendToMain = (msg: AudioToMain, transferList?: unknown[]) => void;

export interface AudioGraphDeps {
  readonly mic: IMicCapture;
  /** Optional — meeting mode only. */
  readonly system?: ISystemAudioCapture;
  readonly send: SendToMain;
  readonly mixerConfig?: MixerConfig;
}

export class AudioGraph {
  private readonly mic: IMicCapture;
  private readonly system?: ISystemAudioCapture;
  private readonly send: SendToMain;
  private mixer: Mixer | null = null;

  /** True between `open_chunk` and `close_chunk`; gates pcm_frame emission. */
  private currentChunkId: string | null = null;
  /** ms offset of the *first* sample we'll emit in the current chunk. */
  private chunkStartMs = 0;
  /** Running offset, advanced by each frame's sample count. */
  private cursorMs = 0;

  /** Tail buffer: last 2 s of mixed PCM, kept so open_chunk can prepend overlap. */
  private overlapTail: Int16Array[] = [];

  /** Subscriptions returned by capture.on, called during stop_session. */
  private unsubs: Array<() => void> = [];
  /**
   * Mic-only subscriptions. Tracked separately from `unsubs` so we can tear
   * down just the mic listeners during a rebind without touching system
   * audio's. Concatenated into `unsubs` at session stop.
   */
  private micUnsubs: Array<() => void> = [];
  /**
   * Start options used for the current mic — replayed on rebind so the new
   * engine instance picks up the same sample rate / channels / device.
   */
  private micStartOpts: { sampleRate: number; channels: 1; deviceId?: string } | null = null;
  /** Coalesces back-to-back device_change events; only the last wins. */
  private rebindDebounceTimer: NodeJS.Timeout | null = null;
  /** Re-entry guard for rebindMic; also blocks self-triggered loops. */
  private rebindInFlight = false;
  /**
   * After a rebind, the new engine often fires its own configuration-change
   * notification almost immediately. Ignoring device_change for a short
   * cooldown prevents a tight rebind→change→rebind loop.
   */
  private rebindCooldownUntil = 0;

  /** Flipped to true on the first mic frame of the current chunk; read by the
   *  audio-process watchdog to detect "engine claims started but no audio". */
  private firstMicFrameSeen = false;

  /**
   * Held-back tail of the prepended overlap (last `CROSSFADE_SAMPLES` samples).
   * Consumed by the first mixer-emitted frame after openChunk: the new frame's
   * head is linearly blended against this tail, smoothing the (already-
   * contiguous-in-time) splice between "prepended overlap" and "new captured
   * audio" and absorbing any single-sample-step discontinuity that would
   * otherwise sound like a click.
   *
   * Cleared on each openChunk so a leftover from a chunk that produced no
   * captured frames doesn't bleed into the next chunk.
   */
  private pendingCrossfade: Int16Array | null = null;
  private static readonly CROSSFADE_SAMPLES = 80; // 5 ms @ 16 kHz

  /** Software AGC applied to mic frames pre-mixer. Re-created on every
   *  startSession so state doesn't leak across recordings. Quiet voice
   *  gets boosted toward -20 dBFS so it can compete with system audio in
   *  the meeting-mode mix. */
  private micAgc = new SoftwareAgc();

  /** Construct over capture deps + send callback. Does not start anything. */
  constructor(deps: AudioGraphDeps) {
    this.mic = deps.mic;
    this.system = deps.system;
    this.send = deps.send;
    this.mixer = new Mixer('dictation', deps.mixerConfig ?? DEFAULT_MIXER_CONFIG);
  }

  /** Wire capture listeners and start both sources. Idempotent: throws if already started. */
  async startSession(msg: StartSessionMsg): Promise<void> {
    if (this.unsubs.length > 0 || this.micUnsubs.length > 0) {
      throw new Error('AudioGraph already started');
    }
    this.mixer = new Mixer(msg.mode, DEFAULT_MIXER_CONFIG);
    this.micAgc = new SoftwareAgc();
    this.firstMicFrameSeen = false;

    this.micStartOpts = {
      sampleRate: msg.sampleRate,
      channels: 1,
      ...(msg.micDeviceId ? { deviceId: msg.micDeviceId } : {}),
    };
    this.attachMicListeners();
    await this.mic.start(this.micStartOpts);

    if (msg.mode === 'meeting' && msg.enableSystemAudio && this.system) {
      this.unsubs.push(
        this.system.on('pcm', (buf) => this.onSystemFrame(buf)),
        this.system.on('deviceChange', (info) =>
          this.send({ type: 'device_change', kind: 'system', label: info.label }),
        ),
        this.system.on('error', (err) =>
          this.send({ type: 'capture_error', source: 'system', message: err.message }),
        ),
      );
      await this.system.start({ sampleRate: msg.sampleRate, channels: 1 });
    }
  }

  /** Diagnostic snapshot used by the audio-process watchdog. */
  diagnosticStatus(): { firstMicFrameSeen: boolean; currentChunkId: string | null } {
    return {
      firstMicFrameSeen: this.firstMicFrameSeen,
      currentChunkId: this.currentChunkId,
    };
  }

  /** Detach listeners, stop sources, drop any queued data. */
  async stopSession(): Promise<void> {
    if (this.rebindDebounceTimer) {
      clearTimeout(this.rebindDebounceTimer);
      this.rebindDebounceTimer = null;
    }
    for (const u of this.micUnsubs) u();
    this.micUnsubs = [];
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.micStartOpts = null;
    await this.mic.stop().catch(() => {});
    if (this.system) await this.system.stop().catch(() => {});
    this.mixer?.drop();
    this.overlapTail = [];
    this.currentChunkId = null;
  }

  /**
   * Attach the mic-side listeners and stash their unsubs in `micUnsubs` so
   * a later rebind can tear down only the mic without disturbing system
   * audio. Idempotent only via the empty-array precondition — callers
   * (startSession, rebindMic) clear `micUnsubs` first.
   */
  private attachMicListeners(): void {
    this.micUnsubs.push(
      this.mic.on('pcm', (buf) => this.onMicFrame(buf)),
      this.mic.on('deviceChange', (info) => this.handleMicDeviceChange(info)),
      this.mic.on('error', (err) =>
        this.send({ type: 'capture_error', source: 'mic', message: err.message }),
      ),
    );
  }

  /**
   * Forward the device-change event to main (for UX), then schedule a
   * rebind. Debounced so a noisy disconnect→reconnect storm coalesces
   * into a single rebind. Cooldown after rebind suppresses the
   * configuration-change notification AVAudioEngine fires when WE
   * just restarted it, breaking what would otherwise be a tight loop.
   */
  private handleMicDeviceChange(info: { label: string | null }): void {
    this.send({ type: 'device_change', kind: 'mic', label: info.label });
    if (Date.now() < this.rebindCooldownUntil) return;
    if (this.rebindDebounceTimer) clearTimeout(this.rebindDebounceTimer);
    this.rebindDebounceTimer = setTimeout(() => {
      this.rebindDebounceTimer = null;
      void this.rebindMic().catch((err) => {
        this.send({
          type: 'capture_error',
          source: 'mic',
          message: `rebindMic failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    }, 400);
  }

  /**
   * Restart the mic capture against whatever the system default is right
   * now. Used when the previously-bound device disappears (Bluetooth out
   * of range, USB unplugged) or when the user changes default. System
   * audio capture is untouched — it taps the meeting app's output, not
   * the input device, so it's immune to mic switches.
   */
  private async rebindMic(): Promise<void> {
    if (!this.mixer || !this.micStartOpts) return; // no active session
    if (this.rebindInFlight) return;
    this.rebindInFlight = true;
    try {
      for (const u of this.micUnsubs) u();
      this.micUnsubs = [];
      await this.mic.stop().catch(() => {});
      await this.mic.start(this.micStartOpts);
      this.attachMicListeners();
      // The new engine may emit one or more configuration-change events
      // shortly after start. Window it out so we don't ping-pong.
      this.rebindCooldownUntil = Date.now() + 1500;
      this.send({ type: 'mic_rebound' });
    } finally {
      this.rebindInFlight = false;
    }
  }

  /**
   * Start a chunk: reset VAD stats, advance the cursor to the chunk start.
   * If `overlapPrefixMs > 0` we prepend the most recent N ms of tail PCM to
   * the chunk — that's the meeting-mode 2 s overlap.
   */
  openChunk(msg: OpenChunkMsg): void {
    if (!this.mixer) return;
    this.currentChunkId = msg.chunkId;
    this.chunkStartMs = msg.startMs;
    this.cursorMs = msg.startMs;
    this.mixer.resetStats();
    this.pendingCrossfade = null;

    if (msg.overlapPrefixMs > 0 && this.overlapTail.length > 0) {
      const overlapFrames = takeTail(this.overlapTail, msToSamples(msg.overlapPrefixMs));
      // Flatten so we can split off the trailing crossfade region.
      const totalSamples = overlapFrames.reduce((s, f) => s + f.length, 0);
      if (totalSamples > 0) {
        const flat = new Int16Array(totalSamples);
        let off = 0;
        for (const f of overlapFrames) {
          flat.set(f, off);
          off += f.length;
        }
        // Hold back the last CROSSFADE_SAMPLES so the first new mixer output
        // can crossfade against them — see `pendingCrossfade`.
        const fadeLen = Math.min(AudioGraph.CROSSFADE_SAMPLES, totalSamples);
        const emitLen = totalSamples - fadeLen;
        if (emitLen > 0) this.emitFrame(flat.subarray(0, emitLen));
        const tail = new Int16Array(fadeLen);
        tail.set(flat.subarray(emitLen));
        this.pendingCrossfade = tail;
      }
    }
  }

  /**
   * Drain queued frames, then emit `chunk_closed` with running stats.
   *
   * Always emits — even if the mixer/chunk isn't fully set up. The receiver
   * (main → ChunkWriter) uses the `chunk_closed` reply as the only signal
   * that a chunk has reached a terminal state. Silently returning here
   * (which the previous version did when `currentChunkId` was null) left
   * main's TranscriptionUx waiting forever for a reply that would never
   * come, freezing the HUD on the processing spinner. A zero-sample reply
   * is the correct degenerate case: ChunkWriter.closeChunk sees zero
   * audio, persists nothing (or persists a VAD-skipped empty chunk),
   * and TranscriptionUx drains the session cleanly.
   */
  closeChunk(msg: CloseChunkMsg): void {
    if (!this.mixer || this.currentChunkId !== msg.chunkId) {
      // Race: this chunk was never opened (open_chunk ran before mixer was
      // ready, or chunkId mismatch from a stale message). Reply with empty
      // stats so the receiver can still transition the chunk to terminal.
      this.send({
        type: 'chunk_closed',
        chunkId: msg.chunkId,
        bytesWritten: 0,
        sumSquares: 0,
        sampleCount: 0,
      });
      this.currentChunkId = null;
      this.firstMicFrameSeen = false;
      return;
    }
    // Drain whole frames first, then flush the trailing partial so we don't
    // leave sub-frame mic samples behind at chunk boundaries.
    for (const raw of this.mixer.pumpAll()) {
      this.emitFrame(this.applyCrossfade(raw));
    }
    const partial = this.mixer.flush();
    if (partial) this.emitFrame(this.applyCrossfade(partial));
    const stats = this.mixer.stats();
    this.send({
      type: 'chunk_closed',
      chunkId: msg.chunkId,
      bytesWritten: stats.bytesWritten,
      sumSquares: stats.sumSquares,
      sampleCount: stats.sampleCount,
    });
    this.currentChunkId = null;
    this.firstMicFrameSeen = false;
  }

  // ─── Capture-source callbacks ────────────────────────────────────────────

  /**
   * Push a mic frame into the mixer and drain any complete output frames it
   * produces. Mic is the lead source — pump only fires on mic arrival.
   * Frames received before `open_chunk` fires are still mixed and pushed
   * into the rolling overlap tail, so the next chunk gets its 2 s pre-roll.
   */
  private onMicFrame(buf: Buffer): void {
    if (!this.mixer) return;
    this.firstMicFrameSeen = true;
    // AGC before the mixer: boost quiet mic toward -20 dBFS so it can compete
    // with system audio. Without this, V2's raw AVAudioEngine capture stays at
    // whatever the OS input level happens to be, and quiet voice loses the mix.
    this.mixer.pushMic(this.micAgc.process(bufferToInt16(buf)));
    for (const raw of this.mixer.pumpAll()) {
      const mixed = this.applyCrossfade(raw);
      this.appendToTail(mixed);
      if (this.currentChunkId) this.emitFrame(mixed);
      // Live-meter sample for the HUD. Cheap (one pass over ~1600 int16s
      // every 100 ms) and decoupled from the chunk-close stats so the meter
      // updates 10× per second instead of once per chunk.
      this.send({ type: 'amplitude_sample', value: rmsNormalized(mixed) });
    }
  }

  /** System frames just feed the mixer's system ring; mic-arrival drives pump. */
  private onSystemFrame(buf: Buffer): void {
    if (!this.mixer) return;
    this.mixer.pushSystem(bufferToInt16(buf));
  }

  /**
   * Blend the first `pendingCrossfade.length` samples of `frame` against the
   * held-back overlap tail (linear ramp). Returns the (possibly-rewritten)
   * frame. No-op when nothing is pending — so this is safe to call on every
   * emit path. See `pendingCrossfade` for the why.
   */
  private applyCrossfade(frame: Int16Array): Int16Array {
    const tail = this.pendingCrossfade;
    if (!tail) return frame;
    this.pendingCrossfade = null;
    const fadeLen = Math.min(tail.length, frame.length);
    const out = new Int16Array(frame.length);
    for (let i = 0; i < fadeLen; i++) {
      const r = (i + 1) / (fadeLen + 1);
      const mixed = Math.round(tail[i]! * (1 - r) + frame[i]! * r);
      out[i] = mixed < -32_768 ? -32_768 : mixed > 32_767 ? 32_767 : mixed | 0;
    }
    if (fadeLen < frame.length) {
      out.set(frame.subarray(fadeLen), fadeLen);
    }
    return out;
  }

  /** Send one mixed frame to main. The cursor advances by the frame duration. */
  private emitFrame(frame: Int16Array): void {
    if (!this.currentChunkId) return;
    const frameMs = samplesToMs(frame.length);
    // Why no transferList: Electron's MessagePortMain only accepts other
    // MessagePortMain objects in the transferList — passing an ArrayBuffer
    // there throws "Port at index 0 is not a valid port", silently dropping
    // every frame. Structured-clone (the default) copies the buffer, which
    // at ~3 KB / 100 ms is a negligible cost.
    const ab = frame.buffer.slice(
      frame.byteOffset,
      frame.byteOffset + frame.byteLength,
    ) as ArrayBuffer;
    this.send({
      type: 'pcm_frame',
      chunkId: this.currentChunkId,
      pcm: ab,
      capturedAtMonoNs: String(process.hrtime.bigint()),
      frameStartMs: this.cursorMs,
    });
    this.cursorMs += frameMs;
  }

  /** Keep at most 2 s of mixed PCM in the tail buffer. */
  private appendToTail(frame: Int16Array): void {
    this.overlapTail.push(frame);
    let total = this.overlapTail.reduce((s, f) => s + f.length, 0);
    const maxSamples = msToSamples(2_000);
    while (total > maxSamples && this.overlapTail.length > 1) {
      const head = this.overlapTail[0]!;
      total -= head.length;
      this.overlapTail.shift();
    }
  }
}

// ─── tiny helpers ──────────────────────────────────────────────────────────

/** Wrap a Buffer (byte-aligned) as an Int16Array view that shares its memory. */
function bufferToInt16(buf: Buffer): Int16Array {
  // The byteOffset on the underlying ArrayBuffer may be non-zero (slice).
  return new Int16Array(buf.buffer, buf.byteOffset, buf.length >>> 1);
}

const SAMPLE_RATE = 16_000;
function msToSamples(ms: number): number {
  return Math.floor((ms / 1000) * SAMPLE_RATE);
}
function samplesToMs(samples: number): number {
  return Math.round((samples / SAMPLE_RATE) * 1000);
}

/**
 * RMS of an int16 mono frame, normalized to [0, 1] using int16 max as the
 * reference. Quick guard against an empty frame.
 */
function rmsNormalized(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i]!;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / frame.length);
  return Math.min(1, rms / 32_767);
}

/** Take the last `n` samples (across frames) from a tail buffer; returns ordered slices. */
function takeTail(frames: readonly Int16Array[], n: number): Int16Array[] {
  if (n <= 0) return [];
  const out: Int16Array[] = [];
  let remaining = n;
  for (let i = frames.length - 1; i >= 0 && remaining > 0; i--) {
    const f = frames[i]!;
    if (f.length <= remaining) {
      out.unshift(f);
      remaining -= f.length;
    } else {
      out.unshift(f.subarray(f.length - remaining));
      remaining = 0;
    }
  }
  return out;
}
