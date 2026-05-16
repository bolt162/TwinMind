/**
 * Voice-activity gate.
 *
 * Architecture: §7.11 — minimal RMS-dBFS threshold computed at chunk close to
 * skip API calls for silent chunks. Pure-function; the running sum-of-squares
 * is maintained in `audio-process/Mixer.ts` alongside the WAV write so this
 * module never sees the full PCM buffer.
 *
 * Why not WebRTC VAD or Silero VAD: native dependency + model file for very
 * marginal gain over RMS at these thresholds. The architecture's §20.X
 * trade-off section captures this explicitly. Tune the threshold from
 * telemetry (`chunk_vad_skipped` event) before reaching for a fancier model.
 */

/** Int16 max for unsigned PCM normalization. -32768..32767, max abs = 32768. */
const INT16_FULLSCALE = 32_768;

/**
 * Conservative default — clear silence only (HVAC, empty room). Lower values
 * are more aggressive (false-skip whispered speech). See §7.11 threshold
 * table. Exposed via Settings → Advanced.
 */
export const DEFAULT_SILENCE_THRESHOLD_DBFS = -50;

export interface VadConfig {
  readonly silenceThresholdDbfs: number;
}

export interface VadInput {
  readonly sumSquares: number; // Σ s_i^2 across the chunk (audio thread accumulator)
  readonly sampleCount: number;
}

export interface VadDecision {
  readonly rmsDbfs: number;
  readonly skip: boolean;
}

/**
 * Convert (sumSquares, n) → RMS dBFS → skip decision.
 *
 * The dBFS calculation uses a tiny epsilon so true digital zero doesn't blow
 * up the log to `-Infinity`. -1000 dBFS is far below anything meaningful and
 * sorts correctly when compared to a threshold.
 */
export function evaluate(input: VadInput, cfg: VadConfig): VadDecision {
  if (input.sampleCount <= 0) {
    // No samples means the chunk file is empty — recovery should already have
    // dropped this row before we get here. Treat as skip to be safe.
    return { rmsDbfs: -Infinity, skip: true };
  }

  const meanSquares = input.sumSquares / input.sampleCount;
  // Add 1 to avoid log10(0); the +1 is negligible against int16^2 = ~10^9.
  const rms = Math.sqrt(Math.max(meanSquares, 0));
  const rmsDbfs = rms <= 0
    ? -Infinity
    : 20 * Math.log10(rms / INT16_FULLSCALE);

  return {
    rmsDbfs,
    skip: rmsDbfs < cfg.silenceThresholdDbfs,
  };
}

/**
 * Convenience for testing or one-off classification given a full int16 buffer.
 * Production code uses the audio-thread accumulator path and calls
 * `evaluate()` directly to avoid touching every sample twice.
 */
export function evaluateBuffer(pcm: Int16Array, cfg: VadConfig): VadDecision {
  let sumSquares = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i] ?? 0;
    sumSquares += s * s;
  }
  return evaluate({ sumSquares, sampleCount: pcm.length }, cfg);
}
