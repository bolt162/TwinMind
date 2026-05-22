/**
 * PcmFileWriter — 16 kHz mono int16 raw-PCM writer.
 *
 * The on-disk intermediate format during capture: no container header, the
 * file is exactly the bytes we received from audio-process, and its size in
 * bytes is `samples * 2`. The `.pcm` is then encoded to `.webm` at chunk
 * close by `WebmEncoder` (or by `RecoveryService` on next launch if a crash
 * landed first).
 *
 * Why no header: the file is consumed in two ways — by `WebmEncoder` at
 * chunk close (which takes input format as ffmpeg flags, not from the file),
 * and by `RecoveryService` on a crash (which reconstructs duration from
 * `bytes / 2 / sampleRate`). No reader needs a RIFF/WAVE wrapper.
 *
 * Crash invariant: each `append()` is a synchronous `fs.writeSync` — PCM
 * lands in the kernel page cache before the call returns. A crash leaves
 * a recoverable `.pcm` file containing every sample that arrived; the
 * orphan-PCM sweep in `RecoveryService` picks it up next launch.
 */

import fs from 'node:fs';

export class PcmFileWriter {
  private fd: number | null = null;
  private dataBytes = 0;

  constructor(public readonly filePath: string) {}

  /** Create the file (mode 0600). No header is written. */
  open(): void {
    if (this.fd !== null) throw new Error(`PcmFileWriter: ${this.filePath} already open`);
    this.fd = fs.openSync(this.filePath, 'w', 0o600);
    this.dataBytes = 0;
  }

  /** Append raw int16 LE PCM bytes. Idempotent on zero-length input. */
  append(pcm: Buffer): void {
    if (this.fd === null) throw new Error(`PcmFileWriter: not open`);
    if (pcm.length === 0) return;
    fs.writeSync(this.fd, pcm);
    this.dataBytes += pcm.length;
  }

  /** fsync + close. Returns byte count so the caller can size the chunk row. */
  close(): { bytes: number; filePath: string } {
    if (this.fd === null) throw new Error(`PcmFileWriter: not open`);
    fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);
    this.fd = null;
    return { bytes: this.dataBytes, filePath: this.filePath };
  }

  /** Close FD and unlink the file. Used on abort/error/phantom-cancel. */
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

  isOpen(): boolean {
    return this.fd !== null;
  }
}
