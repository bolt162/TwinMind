/**
 * Mixer — sample-accurate mic + system PCM combiner.
 *
 * Architecture: §7.5 (pre-mix, mic 1.2× + system 0.4×), §7.11 (VAD).
 *
 * Implementation: two per-source ring buffers + fixed-size frame emission.
 * This mirrors V1's AudioWorklet mixer (which inherited correctness from
 * Web Audio's sample-rate-locked ring) but in plain JS so it works in the
 * utility-process audio thread that doesn't have Web Audio.
 *
 * Why a ring buffer instead of the old FIFO-of-frames: AVAudioEngine emits
 * mic frames in variable sizes (whatever the OS scheduler delivers post-
 * resampling). audiotee emits ~100 ms system frames but with timing jitter.
 * The previous Mixer popped one of each per pump and sized output to the
 * mic frame's length — when system was longer the tail was silently dropped,
 * when shorter the output got zero-padded mid-frame. Both produced audible
 * discontinuities ("clicks").
 *
 * With the ring buffer: both sides push their native variable-size frames
 * into their respective ring; pump emits a fixed `outputFrameSamples` frame
 * by reading exactly that many samples from each ring (mic must be full;
 * system pads with zeros on underrun — matches V1's worklet behavior).
 *
 * Underrun / overflow accounting is preserved as counters callers can read
 * for telemetry; the mixer itself never throws.
 *
 * VAD math: the running `sumSquares` is reset on `resetStats` and frozen on
 * `stats()`. Sum-of-squares of int16 samples over a 30 s chunk peaks around
 * 30 s × 16 000 samples/s × 32768² ≈ 5e14, well inside JS's 2^53 safe range.
 */

const INT16_MIN = -32_768;
const INT16_MAX = 32_767;

/** Output frame size = 100 ms @ 16 kHz; matches the audiotee chunk cadence. */
const DEFAULT_OUTPUT_FRAME_SAMPLES = 1_600;
/** Per-ring capacity = 2 s @ 16 kHz. Plenty of headroom for jitter; if one
 *  source stalls longer than this, we drop oldest (telemetry counts it). */
const DEFAULT_RING_CAPACITY_SAMPLES = 32_000;

function clampI16(v: number): number {
  if (v < INT16_MIN) return INT16_MIN;
  if (v > INT16_MAX) return INT16_MAX;
  return v | 0;
}

/**
 * Single-producer / single-consumer int16 ring buffer. Overflow drops oldest
 * samples (and counts how many were lost) — appropriate for audio capture
 * where dropping ancient data is preferable to backpressure that would stall
 * the audio thread.
 */
class RingBuffer {
  private readonly buf: Int16Array;
  private head = 0;
  private filled = 0;
  private dropped = 0;

  constructor(capacity: number) {
    this.buf = new Int16Array(capacity);
  }

  push(samples: Int16Array): void {
    const cap = this.buf.length;
    const n = samples.length;
    // Bulk fast-path: incoming is larger than the entire ring; keep only the
    // last `cap` samples and reset positions. Older data is lost.
    if (n >= cap) {
      this.buf.set(samples.subarray(n - cap));
      this.dropped += n - cap + this.filled;
      this.head = 0;
      this.filled = cap;
      return;
    }
    const free = cap - this.filled;
    if (n > free) {
      // Make room by dropping the oldest (filled-tail moves forward).
      const overflow = n - free;
      this.filled -= overflow;
      this.dropped += overflow;
    }
    for (let i = 0; i < n; i++) {
      this.buf[this.head] = samples[i]!;
      this.head = (this.head + 1) % cap;
    }
    this.filled += n;
  }

  /** Read up to `count` samples into `dst`, return how many actually read.
   *  Caller is responsible for zero-initializing the tail when this returns
   *  less than `count` and they need a fixed-size frame. */
  readInto(dst: Int16Array, count: number): number {
    const cap = this.buf.length;
    const n = Math.min(count, this.filled);
    let tail = (this.head - this.filled + cap) % cap;
    for (let i = 0; i < n; i++) {
      dst[i] = this.buf[tail]!;
      tail = (tail + 1) % cap;
    }
    this.filled -= n;
    return n;
  }

  available(): number {
    return this.filled;
  }

  drop(): void {
    this.head = 0;
    this.filled = 0;
  }

  droppedSamples(): number {
    return this.dropped;
  }
}

export interface MixerConfig {
  /** Gain multiplier on the mic side. V1 default = 1.2. */
  readonly micGain: number;
  /** Gain multiplier on the system side. V1 default = 0.4. */
  readonly systemGain: number;
}

export const DEFAULT_MIXER_CONFIG: MixerConfig = {
  // Mic enters the mixer already normalized by SoftwareAgc (~-20 dBFS), so
  // the 1.2× boost V1 used (when raw WebRTC mic was bare and a touch quiet)
  // is no longer needed. 1.0 lets the AGC target be the final mic level
  // without double-applying gain.
  micGain: 1.0,
  systemGain: 0.4,
};

/** Optional sizing knobs; defaults are production values. Tests override
 *  `outputFrameSamples` to a small number so they don't need to push 1 600
 *  samples just to coax a single pump output. */
export interface MixerOptions {
  /** Samples per emitted frame. Default 1 600 = 100 ms @ 16 kHz. */
  readonly outputFrameSamples?: number;
  /** Per-source ring capacity in samples. Default 32 000 = 2 s @ 16 kHz. */
  readonly ringCapacitySamples?: number;
}

/** Snapshot of the mixer's running statistics for a chunk. */
export interface ChunkStats {
  readonly sumSquares: number;
  readonly sampleCount: number;
  readonly bytesWritten: number;
}

export class Mixer {
  private readonly micRing: RingBuffer;
  private readonly systemRing: RingBuffer;
  private readonly outputFrameSamples: number;
  private sumSquares = 0;
  private sampleCount = 0;
  private bytesWritten = 0;

  constructor(
    private readonly mode: 'dictation' | 'meeting',
    private readonly config: MixerConfig = DEFAULT_MIXER_CONFIG,
    options: MixerOptions = {},
  ) {
    this.outputFrameSamples = options.outputFrameSamples ?? DEFAULT_OUTPUT_FRAME_SAMPLES;
    const capacity = options.ringCapacitySamples ?? DEFAULT_RING_CAPACITY_SAMPLES;
    this.micRing = new RingBuffer(capacity);
    this.systemRing = new RingBuffer(capacity);
  }

  pushMic(frame: Int16Array): void {
    this.micRing.push(frame);
  }

  pushSystem(frame: Int16Array): void {
    this.systemRing.push(frame);
  }

  /**
   * Emit one fixed-size mixed frame if mic has at least one frame's worth of
   * samples. System is read greedily and zero-padded on underrun — matches
   * V1's AudioWorklet semantics where system is "best-effort" and never
   * holds back the mic. Returns null when mic isn't ready yet.
   */
  pump(): Int16Array | null {
    if (this.micRing.available() < this.outputFrameSamples) return null;
    return this.mix(this.outputFrameSamples);
  }

  /** Drain every complete frame currently mixable. */
  pumpAll(): Int16Array[] {
    const out: Int16Array[] = [];
    let frame: Int16Array | null;
    // eslint-disable-next-line no-cond-assign
    while ((frame = this.pump()) !== null) out.push(frame);
    return out;
  }

  /**
   * Drain any leftover mic samples that don't form a full frame. Used by
   * AudioGraph.closeChunk to flush the trailing partial. Returns null when
   * mic ring is empty.
   */
  flush(): Int16Array | null {
    const avail = this.micRing.available();
    if (avail === 0) return null;
    return this.mix(avail);
  }

  /** Snapshot the running stats; does not reset them. */
  stats(): ChunkStats {
    return {
      sumSquares: this.sumSquares,
      sampleCount: this.sampleCount,
      bytesWritten: this.bytesWritten,
    };
  }

  /** Zero the running stats; called at every chunk boundary. */
  resetStats(): void {
    this.sumSquares = 0;
    this.sampleCount = 0;
    this.bytesWritten = 0;
  }

  /** Drop any queued samples (used on session stop). */
  drop(): void {
    this.micRing.drop();
    this.systemRing.drop();
  }

  /** Total samples dropped by overflow on either side, for diagnostics. */
  droppedSamples(): { mic: number; system: number } {
    return { mic: this.micRing.droppedSamples(), system: this.systemRing.droppedSamples() };
  }

  /** Internal: read `samples` from mic, mix with system (or zero in dictation),
   *  update VAD stats, return the mixed frame. Caller guarantees mic has
   *  `samples` available. */
  private mix(samples: number): Int16Array {
    const mic = new Int16Array(samples);
    this.micRing.readInto(mic, samples);

    const out = new Int16Array(samples);
    const micG = this.config.micGain;

    if (this.mode === 'meeting') {
      const sys = new Int16Array(samples); // zero-initialized
      // readInto fills only the head; the rest stays at 0 (silence padding).
      this.systemRing.readInto(sys, samples);
      const sysG = this.config.systemGain;
      for (let i = 0; i < samples; i++) {
        const mixed = clampI16(Math.round(mic[i]! * micG + sys[i]! * sysG));
        out[i] = mixed;
        this.sumSquares += mixed * mixed;
      }
    } else {
      for (let i = 0; i < samples; i++) {
        const mixed = clampI16(Math.round(mic[i]! * micG));
        out[i] = mixed;
        this.sumSquares += mixed * mixed;
      }
    }

    this.sampleCount += samples;
    this.bytesWritten += out.byteLength;
    return out;
  }
}
