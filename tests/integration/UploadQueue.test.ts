import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '@core/storage/JobStore';
import { MIGRATIONS } from '@core/storage/migrations';
import { prepareDatabase } from '@core/storage/Migrator';
import { UploadQueue } from '@core/queue/UploadQueue';
import { MockAsrClient } from '@core/asr/MockAsrClient';
import { AsrError } from '@core/asr/AsrError';
import { FakeClock } from '@core/util/Clock';

interface Harness {
  dir: string;
  store: JobStore;
  clock: FakeClock;
  audioPath: (id: string) => string;
}

function setup(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinmind-queue-'));
  const db = new Database(':memory:');
  prepareDatabase(db, MIGRATIONS);
  const clock = new FakeClock(1_700_000_000_000);
  const store = new JobStore(db, clock);
  store.createSession({ id: 's1', mode: 'meeting', started_at: clock.now() });
  return {
    dir,
    store,
    clock,
    audioPath: (id) => path.join(dir, `${id}.mixed.webm`),
  };
}

function teardown(h: Harness) {
  fs.rmSync(h.dir, { recursive: true, force: true });
}

/** Insert a chunk row + create a small placeholder audio file. */
function makeChunk(h: Harness, id: string, idx = 0): string {
  const p = h.audioPath(id);
  fs.writeFileSync(p, Buffer.alloc(8, 0x55));
  h.store.insertChunk({
    id,
    session_id: 's1',
    idx,
    source: 'mixed',
    file_path: p,
    start_ms: idx * 30_000,
    end_ms: (idx + 1) * 30_000,
    overlap_prefix_ms: 0,
    duration_ms: 30_000,
    bytes: 8,
    sha256: null,
    device_boundary: false,
    sleep_boundary: false,
  });
  return p;
}

describe('UploadQueue — happy path', () => {
  let h: Harness;
  beforeEach(() => (h = setup()));
  afterEach(() => teardown(h));

  it('captured → completed in one tick, transcript persisted, file unlinked', async () => {
    const p = makeChunk(h, 'c1');
    const asr = new MockAsrClient({ defaultText: 'hello' });
    const q = new UploadQueue(h.store, asr, h.clock, { tickIntervalMs: 9_999_999 });

    q.start();
    await q.tick();
    // Drain the in-flight processChunk promise.
    await q.stop();

    expect(h.store.getChunk('c1')!.state).toBe('completed');
    expect(h.store.getTranscript('c1')!.text).toBe('hello');
    expect(fs.existsSync(p)).toBe(false);
  });
});

describe('UploadQueue — retryable failures', () => {
  let h: Harness;
  beforeEach(() => (h = setup()));
  afterEach(() => teardown(h));

  it('on retryable AsrError, marks failed_retry with backoff', async () => {
    makeChunk(h, 'c1');
    const asr = new MockAsrClient({
      script: [{ kind: 'fail', error: new AsrError('server_5xx', '503') }],
      defaultText: 'rec',
    });
    const q = new UploadQueue(h.store, asr, h.clock, { tickIntervalMs: 9_999_999 });
    q.start();
    await q.tick();
    await q.stop();

    const c = h.store.getChunk('c1')!;
    expect(c.state).toBe('failed_retry');
    expect(c.attempts).toBe(1);
    expect(c.next_attempt_at).toBeGreaterThanOrEqual(h.clock.now());
  });

  it('after the retry-after window, the next tick succeeds', async () => {
    makeChunk(h, 'c1');
    const asr = new MockAsrClient({
      script: [{ kind: 'fail', error: new AsrError('server_5xx', '503') }],
      defaultText: 'second-time',
    });
    const q = new UploadQueue(h.store, asr, h.clock, { tickIntervalMs: 9_999_999 });
    q.start();
    await q.tick(); // fails → failed_retry
    await q.stop();

    // Advance past whatever backoff the policy chose.
    const nextAt = h.store.getChunk('c1')!.next_attempt_at!;
    h.clock.advance(nextAt - h.clock.now() + 1);

    q.start();
    await q.tick(); // re-pickup, succeeds with defaultText
    await q.stop();

    expect(h.store.getChunk('c1')!.state).toBe('completed');
    expect(h.store.getTranscript('c1')!.text).toBe('second-time');
  });
});

describe('UploadQueue — permanent failures', () => {
  let h: Harness;
  beforeEach(() => (h = setup()));
  afterEach(() => teardown(h));

  it('classifies auth (401) as permanent immediately', async () => {
    makeChunk(h, 'c1');
    const asr = new MockAsrClient({
      script: [{ kind: 'fail', error: new AsrError('auth', 'bad key') }],
    });
    const q = new UploadQueue(h.store, asr, h.clock, { tickIntervalMs: 9_999_999 });
    q.start();
    await q.tick();
    await q.stop();
    expect(h.store.getChunk('c1')!.state).toBe('failed_permanent');
  });

  it('exhausts retries after 3 attempts (§11.2 maxAttempts)', async () => {
    makeChunk(h, 'c1');
    const asr = new MockAsrClient({
      script: [
        { kind: 'fail', error: new AsrError('server_5xx', '1') },
        { kind: 'fail', error: new AsrError('server_5xx', '2') },
        { kind: 'fail', error: new AsrError('server_5xx', '3') },
      ],
    });
    const q = new UploadQueue(h.store, asr, h.clock, { tickIntervalMs: 9_999_999 });

    // Cycle: tick → fail → advance past backoff → tick → fail → ...
    for (let i = 0; i < 3; i++) {
      q.start();
      await q.tick();
      await q.stop();
      const c = h.store.getChunk('c1')!;
      if (c.state === 'failed_permanent') break;
      const nextAt = c.next_attempt_at!;
      h.clock.advance(nextAt - h.clock.now() + 1);
    }
    expect(h.store.getChunk('c1')!.state).toBe('failed_permanent');
  });
});

describe('UploadQueue — concurrency cap', () => {
  let h: Harness;
  beforeEach(() => (h = setup()));
  afterEach(() => teardown(h));

  it('never exceeds maxConcurrency in-flight uploads', async () => {
    for (let i = 0; i < 4; i++) makeChunk(h, `c${i}`, i);
    const asr = new MockAsrClient({ defaultText: 'x', defaultDelayMs: 20 });
    const q = new UploadQueue(h.store, asr, h.clock, {
      tickIntervalMs: 9_999_999,
      maxConcurrency: 2,
    });
    q.start();
    await q.tick();
    expect(q.inFlightCount).toBeLessThanOrEqual(2);
    // A second immediate tick must not push us over: slots = 2 - 2 = 0.
    await q.tick();
    expect(q.inFlightCount).toBeLessThanOrEqual(2);
    await q.stop();
    // After drain, the first two should be completed; remaining two still captured
    // until the next tick (which we never fired). All four were not picked at once.
    const states = ['c0', 'c1', 'c2', 'c3'].map((id) => h.store.getChunk(id)!.state);
    const completed = states.filter((s) => s === 'completed').length;
    expect(completed).toBeLessThanOrEqual(2);
  });
});

describe('UploadQueue — non-AsrError', () => {
  let h: Harness;
  beforeEach(() => (h = setup()));
  afterEach(() => teardown(h));

  it('classifies a thrown plain Error as `unknown` and retries', async () => {
    makeChunk(h, 'c1');
    // Use a custom AsrError wrapper isn't needed — the queue should classify
    // any non-AsrError as 'unknown' itself.
    const asr = {
      providerName: 'mock-throw',
      async transcribe() {
        throw new Error('boom');
      },
    };
    const q = new UploadQueue(h.store, asr, h.clock, { tickIntervalMs: 9_999_999 });
    q.start();
    await q.tick();
    await q.stop();
    const c = h.store.getChunk('c1')!;
    expect(c.state).toBe('failed_retry');
    expect(c.last_error_class).toBe('unknown');
  });
});
