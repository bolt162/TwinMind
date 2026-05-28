import { describe, it, expect, afterEach } from 'vitest';

import { AudioGraph } from '@audio-process/AudioGraph';
import type { AudioToMain, OpenChunkMsg } from '@audio-process/protocol';
import type { CaptureEvents, CaptureStartOptions, ICapture } from '@audio-process/IMicCapture';

/**
 * Hand-driven mic: no timers. Tests push exact 100 ms (1 600-sample) frames
 * synchronously so the audio-clock advances deterministically — each push
 * yields exactly one 1 600-sample mixer output (see Mixer.pump), advancing
 * `samplesEmitted` by 1 600 = 100 ms.
 */
class DrivableMic implements ICapture {
  private readonly listeners: { [E in keyof CaptureEvents]: Set<CaptureEvents[E]> } = {
    pcm: new Set(),
    deviceChange: new Set(),
    rebound: new Set(),
    error: new Set(),
  };
  private monoNs = 0n;

  async start(_opts: CaptureStartOptions): Promise<void> {}
  async stop(): Promise<void> {}
  on<E extends keyof CaptureEvents>(event: E, listener: CaptureEvents[E]): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  /** Emit `count` frames of 100 ms voiced PCM (1 600 samples each). */
  pushFrames(count: number): void {
    for (let i = 0; i < count; i++) {
      const arr = new Int16Array(1_600);
      for (let s = 0; s < arr.length; s++) arr[s] = s % 2 === 0 ? 3_277 : -3_277;
      const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
      this.monoNs += 100_000_000n;
      for (const cb of this.listeners.pcm) cb(buf, this.monoNs);
    }
  }
}

function countRotations(msgs: AudioToMain[]): number {
  return msgs.filter((m) => m.type === 'rotation_due').length;
}

describe('AudioGraph — per-chunk rotation target', () => {
  let graph: AudioGraph | null = null;
  afterEach(async () => {
    await graph?.stopSession();
    graph = null;
  });

  async function startMeetingGraph(): Promise<{ mic: DrivableMic; sent: AudioToMain[] }> {
    const mic = new DrivableMic();
    const sent: AudioToMain[] = [];
    graph = new AudioGraph({ mic, send: (m) => sent.push(m) });
    await graph.startSession({
      type: 'start_session',
      sessionId: 's1',
      mode: 'meeting',
      enableSystemAudio: false,
      sampleRate: 16_000,
    });
    return { mic, sent };
  }

  function open(chunkId: string, startMs: number, target: number): OpenChunkMsg {
    return { type: 'open_chunk', chunkId, startMs, overlapPrefixMs: 0, newAudioTargetMs: target };
  }

  it('fires rotation_due exactly once at the supplied 15s target, not before', async () => {
    const { mic, sent } = await startMeetingGraph();
    graph!.openChunk(open('c0', 0, 15_000));

    mic.pushFrames(149); // 14.9 s — below target
    expect(countRotations(sent)).toBe(0);

    mic.pushFrames(1); // 15.0 s — crosses target
    expect(countRotations(sent)).toBe(1);

    mic.pushFrames(50); // keep pushing — guard prevents a re-fire within the chunk
    expect(countRotations(sent)).toBe(1);
  });

  it('honors a different (60s) target on a subsequent chunk', async () => {
    const { mic, sent } = await startMeetingGraph();
    graph!.openChunk(open('c0', 0, 15_000));
    mic.pushFrames(150); // close out chunk 0's window
    expect(countRotations(sent)).toBe(1);

    // Open chunk 1 with the steady 60s target.
    graph!.openChunk(open('c1', 13_000, 60_000));
    const afterOpen = sent.length;

    mic.pushFrames(599); // 59.9 s of new audio — below 60s
    expect(countRotations(sent.slice(afterOpen))).toBe(0);

    mic.pushFrames(1); // 60.0 s — crosses
    expect(countRotations(sent.slice(afterOpen))).toBe(1);
  });

  it('falls back to the legacy 30s default when newAudioTargetMs is omitted', async () => {
    const { mic, sent } = await startMeetingGraph();
    // Omit newAudioTargetMs (defensive path).
    graph!.openChunk({ type: 'open_chunk', chunkId: 'c0', startMs: 0, overlapPrefixMs: 0 });

    mic.pushFrames(299); // 29.9 s
    expect(countRotations(sent)).toBe(0);
    mic.pushFrames(1); // 30.0 s — legacy default
    expect(countRotations(sent)).toBe(1);
  });
});
