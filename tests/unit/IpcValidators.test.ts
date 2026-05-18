import { describe, it, expect } from 'vitest';
import { PUSH, REQUEST } from '@ipc/channels';
import { PushSchemas, RequestSchemas } from '@ipc/validators';

describe('IPC schemas — push events', () => {
  it('accepts a fully-shaped recording_state_changed', () => {
    const r = PushSchemas[PUSH.RECORDING_STATE].safeParse({
      mode: 'meeting',
      state: 'recording',
      sessionId: 'abc',
      elapsedMs: 1234,
    });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown recording mode', () => {
    const r = PushSchemas[PUSH.RECORDING_STATE].safeParse({
      mode: 'siesta',
      state: 'recording',
    });
    expect(r.success).toBe(false);
  });

  it('rejects negative elapsedMs', () => {
    const r = PushSchemas[PUSH.RECORDING_STATE].safeParse({
      mode: 'meeting',
      state: 'recording',
      elapsedMs: -1,
    });
    expect(r.success).toBe(false);
  });

  it('caps transcript_segment_appended text at the documented length', () => {
    const big = 'x'.repeat(64_001);
    const r = PushSchemas[PUSH.TRANSCRIPT_SEGMENT].safeParse({
      sessionId: 's',
      chunkId: 'c',
      source: 'mixed',
      startMs: 0,
      endMs: 30_000,
      text: big,
    });
    expect(r.success).toBe(false);
  });

  it('queue_status_changed requires non-negative integers', () => {
    expect(
      PushSchemas[PUSH.QUEUE_STATUS].safeParse({
        pending: 0,
        uploading: 0,
        failedPermanent: 0,
      }).success,
    ).toBe(true);
    expect(
      PushSchemas[PUSH.QUEUE_STATUS].safeParse({
        pending: -1,
        uploading: 0,
        failedPermanent: 0,
      }).success,
    ).toBe(false);
  });
});

describe('IPC schemas — request channels', () => {
  it('REC_START_MEETING input accepts an empty body and an optional title', () => {
    expect(RequestSchemas[REQUEST.REC_START_MEETING].input.safeParse({}).success).toBe(true);
    expect(
      RequestSchemas[REQUEST.REC_START_MEETING].input.safeParse({ title: 'sprint' }).success,
    ).toBe(true);
  });

  it('REC_STOP_MEETING input requires sessionId', () => {
    expect(RequestSchemas[REQUEST.REC_STOP_MEETING].input.safeParse({}).success).toBe(false);
    expect(
      RequestSchemas[REQUEST.REC_STOP_MEETING].input.safeParse({ sessionId: 's1' }).success,
    ).toBe(true);
  });

  it('SETTINGS_SET requires _version on the payload', () => {
    expect(RequestSchemas[REQUEST.SETTINGS_SET].input.safeParse({}).success).toBe(false);
    expect(
      RequestSchemas[REQUEST.SETTINGS_SET].input.safeParse({ _version: 1, foo: 'bar' }).success,
    ).toBe(true);
  });

  it('SESSION_LIST limit must be a positive integer ≤ 1000', () => {
    expect(RequestSchemas[REQUEST.SESSION_LIST].input.safeParse({}).success).toBe(true);
    expect(
      RequestSchemas[REQUEST.SESSION_LIST].input.safeParse({ limit: 50 }).success,
    ).toBe(true);
    expect(
      RequestSchemas[REQUEST.SESSION_LIST].input.safeParse({ limit: 0 }).success,
    ).toBe(false);
    expect(
      RequestSchemas[REQUEST.SESSION_LIST].input.safeParse({ limit: 1001 }).success,
    ).toBe(false);
  });
});
