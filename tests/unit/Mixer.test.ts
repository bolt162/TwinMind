import { describe, it, expect } from 'vitest';
import { Mixer, DEFAULT_MIXER_CONFIG } from '@audio-process/Mixer';
import { evaluate, type VadConfig } from '@core/audio/VadGate';

// Tests use a small outputFrameSamples so we don't have to push 1 600
// samples just to coax a single pump output. Production defaults to 1 600.
const smallFrames = { outputFrameSamples: 4 };

describe('Mixer — mixing math (ring-buffer)', () => {
  it('dictation mode emits the mic stream scaled by micGain (saturating)', () => {
    const m = new Mixer('dictation', DEFAULT_MIXER_CONFIG, smallFrames);
    m.pushMic(new Int16Array([100, -100, 200, -200]));
    const out = m.pump();
    expect(out).not.toBeNull();
    // micGain = 1.0 default (AGC handles boost upstream) → identity
    expect(Array.from(out!)).toEqual([100, -100, 200, -200]);
  });

  it('meeting mode mixes mic 1.0× + system 0.4× sample-by-sample', () => {
    const m = new Mixer('meeting', DEFAULT_MIXER_CONFIG, { outputFrameSamples: 2 });
    m.pushMic(new Int16Array([100, -100]));
    m.pushSystem(new Int16Array([1_000, 1_000]));
    const out = m.pump()!;
    // 100*1 + 1000*0.4 = 500;  -100*1 + 1000*0.4 = 300
    expect(Array.from(out)).toEqual([500, 300]);
  });

  it('meeting mode pads system with zeros when its ring is short', () => {
    const m = new Mixer('meeting', DEFAULT_MIXER_CONFIG, { outputFrameSamples: 4 });
    m.pushMic(new Int16Array([1_000, -1_000, 1_000, -1_000]));
    // No system frame queued: pad with zeros (V1 worklet behavior — system
    // is best-effort and never holds back the mic).
    const out = m.pump()!;
    expect(Array.from(out)).toEqual([1_000, -1_000, 1_000, -1_000]);
  });

  it('clamps to int16 range (saturating add)', () => {
    const m = new Mixer('meeting', { micGain: 2, systemGain: 2 }, { outputFrameSamples: 1 });
    m.pushMic(new Int16Array([20_000]));
    m.pushSystem(new Int16Array([20_000]));
    const out = m.pump()!;
    expect(out[0]).toBe(32_767);
  });

  it('returns null when mic hasn’t supplied a full frame yet', () => {
    const m = new Mixer('meeting', DEFAULT_MIXER_CONFIG, { outputFrameSamples: 8 });
    m.pushMic(new Int16Array([1, 2, 3])); // only 3 samples, frame needs 8
    m.pushSystem(new Int16Array([1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000]));
    expect(m.pump()).toBeNull();
  });

  it('accumulates partial mic pushes into a single emitted frame', () => {
    // Demonstrates the ring-buffer behavior: small mic pushes don't each
    // produce an output; they accumulate until a full frame is available.
    const m = new Mixer('dictation', DEFAULT_MIXER_CONFIG, { outputFrameSamples: 4 });
    m.pushMic(new Int16Array([10]));
    expect(m.pump()).toBeNull();
    m.pushMic(new Int16Array([20, 30]));
    expect(m.pump()).toBeNull();
    m.pushMic(new Int16Array([40]));
    const out = m.pump()!;
    expect(Array.from(out)).toEqual([10, 20, 30, 40]); // ×1.0
  });

  it('pumpAll drains every complete frame', () => {
    const m = new Mixer('dictation', DEFAULT_MIXER_CONFIG, { outputFrameSamples: 2 });
    m.pushMic(new Int16Array([0, 0, 0, 0, 0, 0])); // 3 full frames worth
    expect(m.pumpAll()).toHaveLength(3);
    expect(m.pump()).toBeNull();
  });

  it('flush emits the trailing partial frame for chunk close', () => {
    const m = new Mixer('dictation', DEFAULT_MIXER_CONFIG, { outputFrameSamples: 4 });
    m.pushMic(new Int16Array([100, 200, 300])); // 3 samples < frame size
    expect(m.pump()).toBeNull();
    const partial = m.flush()!;
    expect(partial.length).toBe(3);
    expect(Array.from(partial)).toEqual([100, 200, 300]);
    expect(m.flush()).toBeNull();
  });

  it('overflow drops oldest samples and counts the loss', () => {
    const m = new Mixer('dictation', DEFAULT_MIXER_CONFIG, {
      outputFrameSamples: 2,
      ringCapacitySamples: 4,
    });
    // Push 6 samples into a 4-capacity ring → 2 oldest dropped.
    m.pushMic(new Int16Array([1, 2, 3, 4, 5, 6]));
    expect(m.droppedSamples().mic).toBe(2);
    // Reading should produce the most recent 4 samples ([3,4,5,6]).
    const a = m.pump()!;
    const b = m.pump()!;
    expect([...a, ...b]).toEqual([3, 4, 5, 6]); // ×1.0
  });
});

describe('Mixer — VAD accumulator feeds VadGate.evaluate', () => {
  const vad: VadConfig = { silenceThresholdDbfs: -50 };

  it('silent mic over a chunk → VadGate says skip', () => {
    const m = new Mixer('meeting', DEFAULT_MIXER_CONFIG, { outputFrameSamples: 160 });
    for (let i = 0; i < 100; i++) m.pushMic(new Int16Array(160)); // 100 frames of zeros
    m.pumpAll();
    const stats = m.stats();
    const decision = evaluate(
      { sumSquares: stats.sumSquares, sampleCount: stats.sampleCount },
      vad,
    );
    expect(decision.skip).toBe(true);
  });

  it('clearly voiced mic over a chunk → VadGate says keep', () => {
    const m = new Mixer('dictation', DEFAULT_MIXER_CONFIG, { outputFrameSamples: 1_000 });
    // -20 dBFS ≈ 3 277. Across 1 000 samples, RMS = 3 277.
    const sample = 3_277;
    const frame = new Int16Array(1_000).fill(sample);
    m.pushMic(frame);
    m.pumpAll();
    const stats = m.stats();
    const decision = evaluate(
      { sumSquares: stats.sumSquares, sampleCount: stats.sampleCount },
      vad,
    );
    expect(decision.skip).toBe(false);
  });

  it('resetStats zeros the accumulator at chunk boundaries', () => {
    const m = new Mixer('dictation', DEFAULT_MIXER_CONFIG, { outputFrameSamples: 3 });
    m.pushMic(new Int16Array([1_000, 2_000, 3_000]));
    m.pumpAll();
    expect(m.stats().sampleCount).toBe(3);
    m.resetStats();
    expect(m.stats()).toEqual({ sumSquares: 0, sampleCount: 0, bytesWritten: 0 });
  });
});
