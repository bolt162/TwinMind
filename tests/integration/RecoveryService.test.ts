import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '@core/storage/JobStore';
import { MIGRATIONS } from '@core/storage/migrations';
import { prepareDatabase } from '@core/storage/Migrator';
import { RecoveryService, DEFAULT_RECOVERY_OPTIONS } from '@core/recovery/RecoveryService';
import { FakeClock } from '@core/util/Clock';

interface Harness {
  dir: string;
  store: JobStore;
  clock: FakeClock;
}

function setup(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinmind-recovery-'));
  const db = new Database(':memory:');
  prepareDatabase(db, MIGRATIONS);
  const clock = new FakeClock(1_700_000_000_000);
  const store = new JobStore(db, clock);
  store.createSession({ id: 's1', mode: 'meeting', started_at: clock.now() });
  return { dir, store, clock };
}

function teardown(h: Harness) {
  fs.rmSync(h.dir, { recursive: true, force: true });
}

function placeFile(dir: string, name: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(8));
  return p;
}

describe('RecoveryService', () => {
  let h: Harness;
  beforeEach(() => (h = setup()));
  afterEach(() => teardown(h));

  it('auto-ends sleep-paused sessions older than the threshold (§7.10)', () => {
    h.store.markSessionPausedBySleep('s1');
    h.clock.advance(31 * 60 * 1000); // past 30 min default
    const r = new RecoveryService(h.store, h.clock).recover();
    expect(r.staleSleepSessions).toBe(1);
    expect(h.store.getSession('s1')!.status).toBe('ended');
    expect(h.store.getSession('s1')!.end_reason).toBe('sleep_timeout');
  });

  it('resets stuck uploading chunks back to captured (§11.5)', () => {
    const p = placeFile(h.dir, 'c1.wav');
    h.store.insertChunk({
      id: 'c1',
      session_id: 's1',
      idx: 0,
      source: 'mixed',
      file_path: p,
      start_ms: 0,
      end_ms: 30_000,
      overlap_prefix_ms: 0,
      duration_ms: 30_000,
      bytes: 8,
      sha256: null,
      device_boundary: false,
      sleep_boundary: false,
    });
    h.store.recordChunkUploadStart('c1'); // → uploading

    h.clock.advance(11 * 60 * 1000); // past 10 min default
    const r = new RecoveryService(h.store, h.clock).recover();
    expect(r.resetUploading).toBe(1);
    expect(h.store.getChunk('c1')!.state).toBe('captured');
  });

  it('deletes orphan files for chunks already in state=completed', () => {
    const p = placeFile(h.dir, 'completed.wav');
    h.store.insertChunk({
      id: 'c1',
      session_id: 's1',
      idx: 0,
      source: 'mixed',
      file_path: p,
      start_ms: 0,
      end_ms: 30_000,
      overlap_prefix_ms: 0,
      duration_ms: 30_000,
      bytes: 8,
      sha256: null,
      device_boundary: false,
      sleep_boundary: false,
    });
    h.store.recordChunkUploadStart('c1');
    h.store.recordChunkSuccessAndComplete(
      {
        chunk_id: 'c1',
        text: 'ok',
        words_json: null,
        provider: 'mock',
        model: null,
        language: null,
        confidence: null,
      },
      () => {
        // Simulate the post-commit delete throwing (e.g., process killed before it ran).
        throw new Error('died before unlink');
      },
    );
    expect(fs.existsSync(p)).toBe(true); // delete failed
    const r = new RecoveryService(h.store, h.clock).recover();
    expect(r.orphanCompletedFilesDeleted).toBe(1);
    expect(fs.existsSync(p)).toBe(false);
  });

  it('marks rows as failed_permanent (file_lost) when the file is missing', () => {
    const p = path.join(h.dir, 'missing.wav');
    h.store.insertChunk({
      id: 'c1',
      session_id: 's1',
      idx: 0,
      source: 'mixed',
      file_path: p,
      start_ms: 0,
      end_ms: 30_000,
      overlap_prefix_ms: 0,
      duration_ms: 30_000,
      bytes: 8,
      sha256: null,
      device_boundary: false,
      sleep_boundary: false,
    });
    // Do not place the file.
    const r = new RecoveryService(h.store, h.clock).recover();
    expect(r.rowsMarkedFileLost).toBe(1);
    const c = h.store.getChunk('c1')!;
    expect(c.state).toBe('failed_permanent');
    expect(c.last_error_class).toBe('file_lost');
  });

  it('sweeps failed_permanent files past the retention horizon (§11.7)', () => {
    const p = placeFile(h.dir, 'old.wav');
    h.store.insertChunk({
      id: 'c1',
      session_id: 's1',
      idx: 0,
      source: 'mixed',
      file_path: p,
      start_ms: 0,
      end_ms: 30_000,
      overlap_prefix_ms: 0,
      duration_ms: 30_000,
      bytes: 8,
      sha256: null,
      device_boundary: false,
      sleep_boundary: false,
    });
    h.store.recordChunkUploadStart('c1');
    h.store.recordChunkPermanentFailure('c1', 'auth', 'no');

    h.clock.advance(31 * 24 * 60 * 60 * 1000); // past 30 days
    const r = new RecoveryService(h.store, h.clock, DEFAULT_RECOVERY_OPTIONS).recover();
    expect(r.retentionFilesDeleted).toBe(1);
    expect(fs.existsSync(p)).toBe(false);
    const c = h.store.getChunk('c1')!;
    expect(c.file_deleted_at).not.toBeNull();
    // And on the *next* recovery pass, the same chunk doesn't double-count.
    const r2 = new RecoveryService(h.store, h.clock, DEFAULT_RECOVERY_OPTIONS).recover();
    expect(r2.retentionFilesDeleted).toBe(0);
    expect(r2.rowsMarkedFileLost).toBe(0);
  });
});
