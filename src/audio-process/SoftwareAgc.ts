/**
 * SoftwareAgc — Automatic Gain Control for the mic stream.
 *
 * Sits between the mic source and the Mixer, applying a smoothly-varying
 * gain that pushes the mic's smoothed RMS toward a target level. Matches
 * one of the three DSP stages V1 got for free from Chromium's WebRTC
 * `audio_processing` module (the others — noise suppression and acoustic
 * echo cancellation — aren't implemented here; see the issue thread for
 * why we're staging the rollout).
 *
 * Why it's needed: V2 captures mic via AVAudioEngine directly, with no
 * preprocessing. Quiet voice (low input level, far mic, etc.) stays quiet —
 * which means when the mixer adds it to loud system audio (YouTube), the
 * mic loses the mix and ASR transcribes the system audio instead.
 *
 * Algorithm: exponential-moving-average RMS tracker + asymmetric attack/
 * release on the gain. Quiet mic gets boosted slowly (release); loud
 * transients drop the gain quickly (attack) so we don't clip. A noise
 * gate prevents amplifying the noise floor when the user isn't speaking.
 */

const INT16_MIN = -32_768;
const INT16_MAX = 32_767;
const INT16_FS = 32_768;

/** Target RMS in dBFS. -20 dBFS ≈ 3 277 int16 — a typical "comfortable
 *  speech level" target also used by webrtc-audio-processing's AGC. */
const DEFAULT_TARGET_DBFS = -20;
/** Gain bounds. Keeps us from amplifying noise to infinity when the mic is
 *  effectively silent, and from collapsing to inaudible when the mic is
 *  saturating. */
const DEFAULT_MIN_GAIN = 0.5;
const DEFAULT_MAX_GAIN = 8.0;
/** Per-frame coefficients for the gain smoother. At ~100 ms frames these
 *  give a fast attack (~3 frames ≈ 300 ms to fully attenuate a sudden loud
 *  transient) and a slow release (~25 frames ≈ 2.5 s to fully boost quiet
 *  speech). Asymmetric on purpose — slow boost avoids pumping, fast cut
 *  avoids clipping. */
const DEFAULT_ATTACK_COEF = 0.3;
const DEFAULT_RELEASE_COEF = 0.04;
/** RMS smoothing coefficient. Tracks the recent ~1 s of input level so the
 *  gain doesn't chase per-frame fluctuations. */
const DEFAULT_RMS_SMOOTH_COEF = 0.1;
/** Below this RMS, the input is treated as noise / silence and the gain is
 *  held instead of being recomputed. -50 dBFS ≈ 104 — at or below the noise
 *  floor of a typical built-in laptop mic. Without the gate, AGC happily
 *  boosts a silent room by 8× (max gain) and that hiss enters the mixer. */
const DEFAULT_NOISE_GATE_RMS = INT16_FS * Math.pow(10, -50 / 20);

export interface AgcOptions {
  readonly targetDbfs?: number;
  readonly minGain?: number;
  readonly maxGain?: number;
  readonly attackCoef?: number;
  readonly releaseCoef?: number;
  readonly rmsSmoothCoef?: number;
  readonly noiseGateRms?: number;
}

export class SoftwareAgc {
  private readonly targetRms: number;
  private readonly minGain: number;
  private readonly maxGain: number;
  private readonly attackCoef: number;
  private readonly releaseCoef: number;
  private readonly rmsSmoothCoef: number;
  private readonly noiseGateRms: number;
  private currentGain = 1.0;
  private smoothedRms = 0;

  constructor(options: AgcOptions = {}) {
    const targetDbfs = options.targetDbfs ?? DEFAULT_TARGET_DBFS;
    this.targetRms = INT16_FS * Math.pow(10, targetDbfs / 20);
    this.minGain = options.minGain ?? DEFAULT_MIN_GAIN;
    this.maxGain = options.maxGain ?? DEFAULT_MAX_GAIN;
    this.attackCoef = options.attackCoef ?? DEFAULT_ATTACK_COEF;
    this.releaseCoef = options.releaseCoef ?? DEFAULT_RELEASE_COEF;
    this.rmsSmoothCoef = options.rmsSmoothCoef ?? DEFAULT_RMS_SMOOTH_COEF;
    this.noiseGateRms = options.noiseGateRms ?? DEFAULT_NOISE_GATE_RMS;
  }

  /**
   * Apply AGC to one int16 PCM frame. Returns a fresh Int16Array with the
   * gain-adjusted samples; the input is not modified. Updates internal state
   * (smoothed RMS + current gain) so the next call starts from where this
   * one left off.
   */
  process(frame: Int16Array): Int16Array {
    // Frame RMS.
    let sumSq = 0;
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i]!;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, frame.length));

    // Smooth across frames so a single loud transient doesn't snap the gain.
    this.smoothedRms = (1 - this.rmsSmoothCoef) * this.smoothedRms + this.rmsSmoothCoef * rms;

    // Only update gain when input is above the noise gate. Below the gate we
    // hold the current gain — amplifying near-silence is how noise floors
    // become audible hiss.
    if (this.smoothedRms >= this.noiseGateRms) {
      const desiredGain = this.targetRms / this.smoothedRms;
      const clampedGain = Math.max(this.minGain, Math.min(this.maxGain, desiredGain));
      // Asymmetric smoothing: fast attack when gain must drop (prevent
      // clipping), slow release when gain must rise (prevent pumping).
      const coef = clampedGain < this.currentGain ? this.attackCoef : this.releaseCoef;
      this.currentGain = (1 - coef) * this.currentGain + coef * clampedGain;
    }

    // Apply the gain with saturating clamp.
    const out = new Int16Array(frame.length);
    const g = this.currentGain;
    for (let i = 0; i < frame.length; i++) {
      const v = Math.round(frame[i]! * g);
      out[i] = v < INT16_MIN ? INT16_MIN : v > INT16_MAX ? INT16_MAX : v | 0;
    }
    return out;
  }

  /** Current gain — exposed for telemetry / debugging only. */
  gain(): number {
    return this.currentGain;
  }

  /** Reset state at session boundaries (so a long-quiet session doesn't
   *  bias the next session). */
  reset(): void {
    this.currentGain = 1.0;
    this.smoothedRms = 0;
  }
}
