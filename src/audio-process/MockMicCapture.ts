/**
 * MockMicCapture — emits scripted PCM frames on a timer.
 *
 * Architecture: §14.3 — used in e2e mode (`MIC_BACKEND=mock_pcm_from_file`)
 * and in any test where we need a deterministic source without real hardware.
 *
 * Two construction modes:
 *   1. `fromBuffer(int16Pcm)` — loops the buffer in 100 ms slices.
 *   2. `silence()` — emits all-zero frames forever.
 *
 * The mock obeys the same contract as the real impls: emits 'pcm', 'deviceChange',
 * 'error' events; `stop()` resolves once no more frames will fire.
 */

import type {
  CaptureEvents,
  CaptureStartOptions,
  DeviceChangeInfo,
  ICapture,
} from './IMicCapture';

const FRAME_MS = 100; // 16 000 samples/s * 0.1 s = 1 600 samples = 3 200 bytes per frame

/** Convert an Int16Array to a Buffer that shares the same ArrayBuffer. */
function int16ToBuffer(arr: Int16Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * Build a sine-wave Int16Array at `freqHz` and `amplitude` for `durationMs`.
 * Used for tests that need real signal (not silence).
 */
export function makeSineWave(
  freqHz: number,
  amplitude: number,
  durationMs: number,
  sampleRate = 16_000,
): Int16Array {
  const samples = Math.floor((durationMs / 1000) * sampleRate);
  const out = new Int16Array(samples);
  const twoPiF = 2 * Math.PI * freqHz;
  for (let i = 0; i < samples; i++) {
    out[i] = Math.round(amplitude * Math.sin((twoPiF * i) / sampleRate));
  }
  return out;
}

export class MockMicCapture implements ICapture {
  private readonly listeners: { [E in keyof CaptureEvents]: Set<CaptureEvents[E]> } = {
    pcm: new Set(),
    deviceChange: new Set(),
    error: new Set(),
  };
  private timer: NodeJS.Timeout | null = null;
  private cursor = 0; // index into the looped buffer
  private monoNs = 0n;
  private monoIncrementNs = BigInt(FRAME_MS * 1_000_000);

  /**
   * Construct over a source PCM buffer (looped) — pass `silence` Int16Array
   * for a quiet capture, or `makeSineWave(...)` for a synthetic voiced signal.
   */
  constructor(private readonly source: Int16Array) {}

  /** Build an empty (zero-amplitude) mock source — produces silence forever. */
  static silence(): MockMicCapture {
    return new MockMicCapture(new Int16Array(16_000));
  }

  /** Build a mock that emits a sine wave on loop; convenient for VAD-positive tests. */
  static sine(freqHz = 440, amplitude = 3_277, durationMs = 1_000): MockMicCapture {
    return new MockMicCapture(makeSineWave(freqHz, amplitude, durationMs));
  }

  /** Begin emitting 'pcm' on a 100 ms timer. Idempotent. */
  async start(_opts: CaptureStartOptions): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), FRAME_MS);
  }

  /** Stop emitting frames. Idempotent. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Add a listener; returns an unsubscribe callback. */
  on<E extends keyof CaptureEvents>(event: E, listener: CaptureEvents[E]): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  /** Test helper: emit a synthetic device-change event. */
  emitDeviceChange(info: DeviceChangeInfo = { label: 'mock' }): void {
    for (const cb of this.listeners.deviceChange) cb(info);
  }

  /** Test helper: emit a synthetic error event. */
  emitError(err: Error): void {
    for (const cb of this.listeners.error) cb(err);
  }

  /** Emit one 100 ms slice from the source buffer; loop at the end. */
  private tick(): void {
    const samplesPerFrame = Math.floor((FRAME_MS / 1000) * 16_000);
    const frame = new Int16Array(samplesPerFrame);
    for (let i = 0; i < samplesPerFrame; i++) {
      frame[i] = this.source[this.cursor] ?? 0;
      this.cursor = (this.cursor + 1) % this.source.length;
    }
    this.monoNs += this.monoIncrementNs;
    const buf = int16ToBuffer(frame);
    for (const cb of this.listeners.pcm) cb(buf, this.monoNs);
  }
}
