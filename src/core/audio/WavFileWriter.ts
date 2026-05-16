/**
 * WavFileWriter — 16 kHz mono int16 WAV writer.
 *
 * Architecture: §7.4 (dictation, single growing WAV), §7.5 (meeting, one
 * mixed WAV per chunk), §7.9 invariant 1 ("PCM hits disk before UI gets
 * 'recording' ack").
 *
 * File layout:
 *   - On `open()`, we write a 44-byte placeholder RIFF/WAVE header. The two
 *     length fields (RIFF chunk size at offset 4 and `data` size at offset
 *     40) are set to 0; they're patched in `close()`.
 *   - Every `append(buf)` is a synchronous write of int16 PCM bytes. We
 *     intentionally do NOT buffer in JS — PCM hits the kernel page cache
 *     on every call so a crash mid-recording leaves a recoverable file.
 *   - On `close()`, we patch the two size fields with `fs.writeSync` at the
 *     fixed offsets and `fsyncSync` before closing the FD.
 *
 * We keep the writer sync (not async streams) because the call pattern is
 * one tiny write per ~100 ms PCM frame — async would only add overhead and
 * make the recovery story harder (queue depth on an async stream is invisible
 * to crash recovery).
 */

import fs from 'node:fs';

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const HEADER_BYTES = 44;

/** Build the 44-byte WAV header with placeholder size fields = 0. */
function buildPlaceholderHeader(): Buffer {
  const buf = Buffer.alloc(HEADER_BYTES);
  const byteRate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(0, 4); // ChunkSize — patched in close()
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // Subchunk1Size for PCM
  buf.writeUInt16LE(1, 20); // AudioFormat = PCM
  buf.writeUInt16LE(CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(0, 40); // Subchunk2Size — patched in close()
  return buf;
}

export class WavFileWriter {
  private fd: number | null = null;
  private dataBytes = 0;

  /** Construct over an absolute path. Does not touch disk until `open()`. */
  constructor(public readonly filePath: string) {}

  /** Create the file (mode 0600) and write the placeholder header. */
  open(): void {
    if (this.fd !== null) throw new Error(`WavFileWriter: ${this.filePath} already open`);
    this.fd = fs.openSync(this.filePath, 'w', 0o600);
    fs.writeSync(this.fd, buildPlaceholderHeader());
    this.dataBytes = 0;
  }

  /** Append `pcm` (raw int16 little-endian bytes). Idempotent on zero-length input. */
  append(pcm: Buffer): void {
    if (this.fd === null) throw new Error(`WavFileWriter: not open`);
    if (pcm.length === 0) return;
    fs.writeSync(this.fd, pcm);
    this.dataBytes += pcm.length;
  }

  /**
   * Patch the two size fields, fsync, close. Returns the final byte counts so
   * the caller can populate the `chunks` row (`bytes`, `duration_ms`).
   */
  close(): { bytes: number; dataBytes: number; durationMs: number; filePath: string } {
    if (this.fd === null) throw new Error(`WavFileWriter: not open`);

    // RIFF chunk size = total file size - 8 (the first 8 bytes are RIFF + size itself).
    const totalBytes = HEADER_BYTES + this.dataBytes;
    const riffChunkSize = totalBytes - 8;

    const sizes = Buffer.alloc(4);
    sizes.writeUInt32LE(riffChunkSize, 0);
    fs.writeSync(this.fd, sizes, 0, 4, 4); // offset 4 in the file

    sizes.writeUInt32LE(this.dataBytes, 0);
    fs.writeSync(this.fd, sizes, 0, 4, 40); // offset 40 in the file

    fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);
    this.fd = null;

    const durationMs = Math.round((this.dataBytes / (SAMPLE_RATE * CHANNELS * 2)) * 1000);
    return { bytes: totalBytes, dataBytes: this.dataBytes, durationMs, filePath: this.filePath };
  }

  /** Close the FD without patching the header and delete the file. Used on abort/error. */
  abort(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* best-effort */
      }
      this.fd = null;
    }
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      /* best-effort */
    }
  }

  /** True if `open()` has been called and `close()`/`abort()` has not. */
  isOpen(): boolean {
    return this.fd !== null;
  }
}
