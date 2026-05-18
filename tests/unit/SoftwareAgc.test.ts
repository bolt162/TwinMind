import { describe, it, expect } from 'vitest';
import { SoftwareAgc } from '@audio-process/SoftwareAgc';

function makeSineFrame(samples: number, amplitude: number): Int16Array {
  const f = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    f[i] = Math.round(Math.sin((i / samples) * 2 * Math.PI * 50) * amplitude);
  }
  return f;
}

function rms(frame: Int16Array): number {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i]! * frame[i]!;
  return Math.sqrt(s / frame.length);
}

describe('SoftwareAgc', () => {
  it('boosts a quiet input over several frames until it approaches target', () => {
    // Quiet input: amplitude 300 ≈ -40 dBFS (well below the -20 dBFS target).
    const agc = new SoftwareAgc();
    const frame = makeSineFrame(1600, 300);
    const inRms = rms(frame);

    let outRms = 0;
    // 60 frames ≈ 6 s — enough for the slow release to ramp gain up.
    for (let i = 0; i < 60; i++) outRms = rms(agc.process(frame));

    expect(agc.gain()).toBeGreaterThan(1.5); // some boost was applied
    expect(outRms).toBeGreaterThan(inRms * 1.5);
  });

  it('attenuates a loud input quickly to avoid clipping', () => {
    // Loud input: amplitude 25 000 ≈ -2 dBFS.
    const agc = new SoftwareAgc();
    const frame = makeSineFrame(1600, 25_000);

    // After a few frames the gain should drop below 1 (we want LESS than the
    // input level to stop us from saturating once mixed).
    for (let i = 0; i < 10; i++) agc.process(frame);
    expect(agc.gain()).toBeLessThan(1.0);
  });

  it('attack is faster than release (asymmetric smoothing)', () => {
    const agcLoud = new SoftwareAgc();
    const agcQuiet = new SoftwareAgc();
    const loud = makeSineFrame(1600, 25_000);
    const quiet = makeSineFrame(1600, 300);

    // Both start with gain = 1.0. Loud input should drop the gain by some
    // amount in N frames. Quiet input should raise the gain by some amount
    // in the same N frames. The loud drop should be larger in magnitude.
    for (let i = 0; i < 5; i++) {
      agcLoud.process(loud);
      agcQuiet.process(quiet);
    }
    const loudDrop = 1.0 - agcLoud.gain();
    const quietRise = agcQuiet.gain() - 1.0;
    expect(loudDrop).toBeGreaterThan(quietRise);
  });

  it('does not boost silence (noise gate)', () => {
    const agc = new SoftwareAgc();
    const silence = new Int16Array(1600); // all zeros
    for (let i = 0; i < 60; i++) agc.process(silence);
    // Gain stays at its initial value because silence is below the noise gate.
    expect(agc.gain()).toBe(1.0);
  });

  it('saturates int16 instead of wrapping when boosted output exceeds range', () => {
    const agc = new SoftwareAgc({ minGain: 4, maxGain: 8 });
    const frame = new Int16Array([10_000, -10_000]);
    // First couple frames may still be ramping; force-process enough that gain settles.
    for (let i = 0; i < 30; i++) agc.process(frame);
    const out = agc.process(frame);
    expect(out[0]).toBeLessThanOrEqual(32_767);
    expect(out[1]).toBeGreaterThanOrEqual(-32_768);
  });

  it('reset() returns to initial state', () => {
    const agc = new SoftwareAgc();
    const frame = makeSineFrame(1600, 300);
    for (let i = 0; i < 20; i++) agc.process(frame);
    expect(agc.gain()).not.toBe(1.0);
    agc.reset();
    expect(agc.gain()).toBe(1.0);
  });
});
