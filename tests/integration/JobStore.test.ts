import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '@core/storage/migrations';
import { prepareDatabase } from '@core/storage/Migrator';
import { ChunkTransitionConflict, JobStore } from '@core/storage/JobStore';
import { FakeClock } from '@core/util/Clock';

/** Spin up a fresh in-memory DB with the V1 schema applied. */
function setup() {
  const db = new Database(':memory:');
  prepareDatabase(db, MIGRATIONS);
  const clock = new FakeClock(1_000_000); // arbitrary epoch ms
  const store = new JobStore(db, clock);
  return { db, clock, store };
}

function newChunkInput(over: Partial<Parameters<JobStore['insertChunk']>[0]> = {}) {
  return {
    id: 'c1',
    session_id: 's1',
    idx: 0,
    source: 'mixed' as const,
    file_path: '/tmp/c1.mixed.webm',
    start_ms: 0,
    end_ms: 30_000,
    overlap_prefix_ms: 0,
    duration_ms: 30_000,
    bytes: 960_000,
    sha256: null,
    device_boundary: false,
    sleep_boundary: false,
    ...over,
  };
}

describe('JobStore — sessions', () => {
  it('createSession persists and returns the row', () => {
    const { store } = setup();
    const s = store.createSession({
      id: 's1',
      mode: 'meeting',
      started_at: 1_000_000,
      title: 'standup',
    });
    expect(s.id).toBe('s1');
    expect(s.status).toBe('active');
    expect(s.title).toBe('standup');
    expect(s.ended_at).toBeNull();
  });

  it('endSession sets ended_at + end_reason and only matches active', () => {
    const { store, clock } = setup();
    store.createSession({ id: 's1', mode: 'meeting', started_at: 1_000_000 });
    clock.advance(5_000);
    store.endSession('s1', clock.now(), 'user');
    const after = store.getSession('s1')!;
    expect(after.status).toBe('ended');
    expect(after.ended_at).toBe(1_005_000);
    expect(after.end_reason).toBe('user');
    // Idempotent: a second end on the same session is a no-op (no row matches).
    expect(() => store.endSession('s1', clock.now(), 'user')).toThrow(/not found/);
  });

  it('markSessionPausedBySleep flips status without touching ended_at', () => {
    const { store } = setup();
    store.createSession({ id: 's1', mode: 'meeting', started_at: 1_000_000 });
    store.markSessionPausedBySleep('s1');
    const r = store.getSession('s1')!;
    expect(r.status).toBe('paused_by_sleep');
    expect(r.ended_at).toBeNull();
  });

  it('autoEndStaleSleepPaused ends sessions older than threshold (§11.5)', () => {
    const { store, clock } = setup();
    // s_old starts at t=1_000_000 and is paused.
    store.createSession({ id: 's_old', mode: 'meeting', started_at: clock.now() });
    store.markSessionPausedBySleep('s_old');
    // 1 hour later, s_new starts and is also paused.
    clock.advance(60 * 60 * 1000);
    store.createSession({ id: 's_new', mode: 'meeting', started_at: clock.now() });
    store.markSessionPausedBySleep('s_new');
    // Threshold = now - 30 min. s_old (1 h ago) is past it; s_new (just now) is not.
    const ended = store.autoEndStaleSleepPaused(clock.now(), 30 * 60 * 1000);
    expect(ended).toBe(1);
    expect(store.getSession('s_old')!.status).toBe('ended');
    expect(store.getSession('s_old')!.end_reason).toBe('sleep_timeout');
    expect(store.getSession('s_new')!.status).toBe('paused_by_sleep');
  });

  it('deleteSession cascades to chunks + transcripts', () => {
    const { store } = setup();
    store.createSession({ id: 's1', mode: 'meeting', started_at: 0 });
    store.insertChunk(newChunkInput());
    store.recordChunkUploadStart('c1');
    store.recordChunkSuccessAndComplete(
      {
        chunk_id: 'c1',
        text: 'hi',
        words_json: null,
        provider: 'mock',
        model: null,
        language: null,
        confidence: null,
      },
      () => {},
    );
    store.deleteSession('s1');
    expect(store.getChunk('c1')).toBeUndefined();
    expect(store.getTranscript('c1')).toBeUndefined();
  });
});

describe('JobStore — chunk FSM (CAS transitions)', () => {
  it('insertChunk starts in state=captured', () => {
    const { store } = setup();
    store.createSession({ id: 's1', mode: 'meeting', started_at: 0 });
    const c = store.insertChunk(newChunkInput());
    expect(c.state).toBe('captured');
    expect(c.attempts).toBe(0);
  });

  it('recordChunkUploadStart moves captured → uploading and bumps attempts', () => {
    const { store } = setup();
    store.createSession({ id: 's1', mode: 'meeting', started_at: 0 });
    store.insertChunk(newChunkInput());
    store.recordChunkUploadStart('c1');
    const c = store.getChunk('c1')!;
    expect(c.state).toBe('uploading');
    expect(c.attempts).toBe(1);
  });

  it('recordChunkUploadStart throws on a chunk not eligible (terminal state)', () => {
    const { store } = setup();
    store.createSession({ id: 's1', mode: 'meeting', started_at: 0 });
    store.insertChunk(newChunkInput());
    store.recordChunkUploadStart('c1');
    store.recordChunkPermanentFailure('c1', 'auth', 'invalid key');
    expect(() => store.recordChunkUploadStart('c1')).toThrow(ChunkTransitionConflict);
  });

  it('recordChunkSuccessAndComplete writes transcript + completes in one txn', () => {
    const { store } = setup();
    store.createSession({ id: 's1', mode: 'meeting', started_at: 0 });
    store.insertChunk(newChunkInput());
    store.recordChunkUploadStart('c1');
    let deleted = false;
    store.recordChunkSuccessAndComplete(
      {
        chunk_id: 'c1',
        text: 'hello world',
        words_json: null,
        provider: 'groq',
        model: 'whisper-large-v3',
        language: 'en',
        confidence: 0.95,
      },
      () => {
        deleted = true;
      },
    );
    expect(deleted).toBe(true);
    expect(store.getChunk('c1')!.state).toBe('completed');
    expect(store.getTranscript('c1')!.text).toBe('hello world');
  });

  it('recordChunkSuccessAndComplete swallows a deleteFileFn error (RecoveryService cleans up)', () => {
    const { store } = setup();
    store.createSession({ id: 's1', mode: 'meeting', started_at: 0 });
    store.insertChunk(newChunkInput());
    store.recordChunkUploadStart('c1');
    expect(() =>
      store.recordChunkSuccessAndComplete(
        {
          chunk_id: 'c1',
          text: 'x',
          words_json: null,
          provider: 'groq',
          model: null,
          language: null,
          confidence: null,
        },
        () => {
          throw new Error('disk gone');
        },
      ),
    ).not.toThrow();
    expect(store.getChunk('c1')!.state).toBe('completed');
  });

  it('recordChunkRetryableFailure: uploading → failed_retry with next_attempt_at + error', () => {
    const { store } = setup();
    store.createSession({ id: 's1', mode: 'meeting', started_at: 0 });
    store.insertChunk(newChunkInput());
    store.recordChunkUploadStart('c1');
    store.recordChunkRetryableFailure('c1', 1_000_500, 'server_5xx', 'bad gateway');
    const c = store.getChunk('c1')!;
    expect(c.state).toBe('failed_retry');
    expect(c.next_attempt_at).toBe(1_000_500);
    expect(c.last_error_class).toBe('server_5xx');
  });

  it('recordChunkPermanentFailure: works from uploading OR failed_retry', () => {
    const { store } = setup();
    store.createSession({ id: 's1', mode: 'meeting', started_at: 0 });

    // From uploading
    store.insertChunk(newChunkInput({ id: 'a' }));
    store.recordChunkUploadStart('a');
    store.recordChunkPermanentFailure('a', 'auth', 'bad key');
    expect(store.getChunk('a')!.state).toBe('failed_permanent');

    // From failed_retry
    store.insertChunk(newChunkInput({ id: 'b', idx: 1 }));
    store.recordChunkUploadStart('b');
    store.recordChunkRetryableFailure('b', 0, 'server_5xx', 'x');
    store.recordChunkPermanentFailure('b', 'unknown', 'gave up after retries');
    expect(store.getChunk('b')!.state).toBe('failed_permanent');
  });
});

describe('JobStore — upload eligibility', () => {
  it('picks captured + failed_retry whose next_attempt_at has passed', () => {
    const { store, clock } = setup();
    store.createSession({ id: 's1', mode: 'meeting', started_at: 0 });
    store.insertChunk(newChunkInput({ id: 'fresh', idx: 0 }));
    store.insertChunk(newChunkInput({ id: 'later', idx: 1 }));
    store.recordChunkUploadStart('later');
    store.recordChunkRetryableFailure('later', clock.now() + 60_000, 'server_5xx', 'x');

    // Time hasn't moved → "later" should not be eligible yet.
    let picks = store.pickEligibleChunks(clock.now(), 10);
    expect(picks.map((c) => c.id)).toEqual(['fresh']);

    // Advance past the retry deadline → both eligible.
    clock.advance(60_001);
    picks = store.pickEligibleChunks(clock.now(), 10);
    expect(picks.map((c) => c.id).sort()).toEqual(['fresh', 'later']);

    // Terminal-state chunks never appear.
    store.recordChunkUploadStart('fresh');
    store.recordChunkPermanentFailure('fresh', 'auth', 'no');
    picks = store.pickEligibleChunks(clock.now(), 10);
    expect(picks.map((c) => c.id)).toEqual(['later']);
  });
});

describe('JobStore — recovery helpers', () => {
  it('resetStuckUploading flips long-running uploading rows back to captured', () => {
    const { store, clock } = setup();
    store.createSession({ id: 's1', mode: 'meeting', started_at: 0 });
    store.insertChunk(newChunkInput());
    store.recordChunkUploadStart('c1');
    const before = store.getChunk('c1')!;
    expect(before.state).toBe('uploading');
    expect(before.attempts).toBe(1);

    // Move time far ahead; the threshold for stale = 10 min.
    clock.advance(11 * 60 * 1000);
    const reset = store.resetStuckUploading(10 * 60 * 1000);
    expect(reset).toBe(1);

    const after = store.getChunk('c1')!;
    expect(after.state).toBe('captured');
    // Attempts is intentionally preserved (§11.5).
    expect(after.attempts).toBe(1);
  });

  it('findFailedPermanentDueForRetention only matches old failed_permanent with NULL file_deleted_at', () => {
    const { store, clock } = setup();
    store.createSession({ id: 's1', mode: 'meeting', started_at: 0 });

    store.insertChunk(newChunkInput({ id: 'old', idx: 0 }));
    store.recordChunkUploadStart('old');
    store.recordChunkPermanentFailure('old', 'auth', 'x');

    clock.advance(31 * 24 * 60 * 60 * 1000); // 31 days
    const due = store.findFailedPermanentDueForRetention(30 * 24 * 60 * 60 * 1000);
    expect(due.map((c) => c.id)).toEqual(['old']);

    store.markChunkFileDeleted('old', clock.now());
    const due2 = store.findFailedPermanentDueForRetention(30 * 24 * 60 * 60 * 1000);
    expect(due2).toEqual([]);
    expect(store.getChunk('old')!.file_deleted_at).not.toBeNull();
  });
});

describe('JobStore — mic activity + kv', () => {
  it('records and lists mic activity events newest-first', () => {
    const { store } = setup();
    store.recordMicActivityEvent({ occurred_at: 100, state: 'started' });
    store.recordMicActivityEvent({ occurred_at: 200, state: 'stopped' });
    const evs = store.listMicActivityEvents(10);
    expect(evs.map((e) => e.state)).toEqual(['stopped', 'started']);
  });

  it('kv upserts and reads', () => {
    const { store } = setup();
    expect(store.getKv('groq_api_key_enc')).toBeUndefined();
    store.setKv('groq_api_key_enc', 'AQID');
    expect(store.getKv('groq_api_key_enc')).toBe('AQID');
    store.setKv('groq_api_key_enc', 'BBBB');
    expect(store.getKv('groq_api_key_enc')).toBe('BBBB');
    store.deleteKv('groq_api_key_enc');
    expect(store.getKv('groq_api_key_enc')).toBeUndefined();
  });
});
