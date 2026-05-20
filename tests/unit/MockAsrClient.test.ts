import { describe, it, expect } from 'vitest';
import { MockAsrClient } from '@core/asr/MockAsrClient';
import { AsrError } from '@core/asr/AsrError';
import type { TranscribeRequest } from '@core/asr/IAsrClient';

const req: TranscribeRequest = {
  audioPath: '/tmp/nope.wav',
  sessionId: 's1',
  mode: 'meeting',
  source: 'mixed',
  startOffsetMs: 0,
  endOffsetMs: 30_000,
  overlapPrefixMs: 0,
  chunkWallClockStartMs: 1_700_000_000_000,
  chunkWallClockEndMs: 1_700_000_030_000,
};

describe('MockAsrClient', () => {
  it('returns defaultText forever when no script is provided', async () => {
    const c = new MockAsrClient({ defaultText: 'hi' });
    const a = await c.transcribe(req);
    const b = await c.transcribe(req);
    expect(a.text).toBe('hi');
    expect(b.text).toBe('hi');
    expect(c.callCount).toBe(2);
  });

  it('follows a script step-by-step and falls back to defaultText afterwards', async () => {
    const c = new MockAsrClient({
      script: [
        { kind: 'success', text: 'one' },
        { kind: 'success', text: 'two' },
      ],
      defaultText: 'three',
    });
    expect((await c.transcribe(req)).text).toBe('one');
    expect((await c.transcribe(req)).text).toBe('two');
    expect((await c.transcribe(req)).text).toBe('three');
  });

  it('throws scripted AsrError on `fail` steps', async () => {
    const err = new AsrError('server_5xx', 'bad gateway');
    const c = new MockAsrClient({ script: [{ kind: 'fail', error: err }] });
    await expect(c.transcribe(req)).rejects.toBe(err);
  });

  it('stamps provider + durationMs from request offsets', async () => {
    const c = new MockAsrClient({ defaultText: 'x', model: 'mock-x' });
    const seg = await c.transcribe(req);
    expect(seg.provider).toBe('mock');
    expect(seg.model).toBe('mock-x');
    expect(seg.durationMs).toBe(30_000);
  });
});
