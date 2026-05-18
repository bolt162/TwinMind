import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SILENCE_THRESHOLD_DBFS,
  evaluate,
  evaluateBuffer,
  type VadConfig,
} from '@core/audio/VadGate';

const cfg: VadConfig = { silenceThresholdDbfs: DEFAULT_SILENCE_THRESHOLD_DBFS };

// Build a synthetic int16 PCM buffer at a given RMS amplitude (0..32767).
function makePcmAtRms(rms: number, length = 16_000): Int16Array {
  // For an alternating ±rms square wave, mean square == rms^2 → RMS == |rms|.
  const buf = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    buf[i] = i % 2 === 0 ? rms : -rms;
  }
  return buf;
}

describe('VadGate', () => {
  it('treats a zero-length chunk as a skip (edge case for empty file)', () => {
    const d = evaluate({ sumSquares: 0, sampleCount: 0 }, cfg);
    expect(d.skip).toBe(true);
    expect(d.rmsDbfs).toBe(-Infinity);
  });

  it('treats true digital silence as a skip', () => {
    const pcm = new Int16Array(16_000); // all zeros
    const d = evaluateBuffer(pcm, cfg);
    expect(d.skip).toBe(true);
    expect(d.rmsDbfs).toBe(-Infinity);
  });

  it('skips chunks below the default -50 dBFS threshold', () => {
    // -60 dBFS → amplitude ≈ 32768 * 10^(-60/20) = ~32.77
    const pcm = makePcmAtRms(32);
    const d = evaluateBuffer(pcm, cfg);
    expect(d.skip).toBe(true);
    expect(d.rmsDbfs).toBeLessThan(-55);
  });

  it('keeps chunks above the default threshold (clearly voiced level)', () => {
    // -20 dBFS → amplitude ≈ 32768 * 10^(-20/20) ≈ 3277
    const pcm = makePcmAtRms(3277);
    const d = evaluateBuffer(pcm, cfg);
    expect(d.skip).toBe(false);
    expect(d.rmsDbfs).toBeGreaterThan(-22);
    expect(d.rmsDbfs).toBeLessThan(-18);
  });

  it('respects a custom threshold (more aggressive)', () => {
    // At -45 dBFS the same -50-region signal that previously passed should now be skipped.
    const aggressive: VadConfig = { silenceThresholdDbfs: -45 };
    // -48 dBFS → amplitude ≈ 130
    const pcm = makePcmAtRms(130);
    expect(evaluateBuffer(pcm, cfg).skip).toBe(false); // -48 > -50 → keep
    expect(evaluateBuffer(pcm, aggressive).skip).toBe(true); // -48 < -45 → skip
  });

  it('streaming evaluate() matches buffer-based evaluateBuffer()', () => {
    // The audio thread maintains sumSquares incrementally; this test guarantees
    // the two code paths produce the same decision for the same PCM.
    const pcm = makePcmAtRms(500);
    let sumSquares = 0;
    for (let i = 0; i < pcm.length; i++) sumSquares += (pcm[i] ?? 0) ** 2;

    const streamed = evaluate({ sumSquares, sampleCount: pcm.length }, cfg);
    const buffered = evaluateBuffer(pcm, cfg);
    expect(streamed.skip).toBe(buffered.skip);
    expect(streamed.rmsDbfs).toBeCloseTo(buffered.rmsDbfs, 6);
  });
});
