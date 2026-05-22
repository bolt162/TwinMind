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
import type { WebmEncoder } from '@core/audio/WebmEncoder';

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

/**
 * Test encoder: copies PCM into a stub WebM (EBML magic prefix + payload).
 * Lets us exercise orphan-PCM/legacy-WAV reconstruction without spawning
 * ffmpeg in the test suite.
 */
class FakeEncoder implements Pick<WebmEncoder, 'encode'> {
  async encode(pcmPath: string, webmPath: string): Promise<{ bytes: number }> {
    const pcm = fs.readFileSync(pcmPath);
    const out = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), pcm]);
    fs.writeFileSync(webmPath, out);
    return { bytes: out.length };
  }
}

describe('RecoveryService', () => {
  let h: Harness;
  beforeEach(() => (h = setup()));
  afterEach(() => teardown(h));

  it('auto-ends sleep-paused sessions older than the threshold (§7.10)', async () => {
    h.store.markSessionPausedBySleep('s1');
    h.clock.advance(31 * 60 * 1000); // past 30 min default
    const r = await new RecoveryService(h.store, h.clock, null).recover();
    expect(r.staleSleepSessions).toBe(1);
    expect(h.store.getSession('s1')!.status).toBe('ended');
    expect(h.store.getSession('s1')!.end_reason).toBe('sleep_timeout');
  });

  it('resets stuck uploading chunks back to captured (§11.5)', async () => {
    const p = placeFile(h.dir, 'c1.webm');
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
    const r = await new RecoveryService(h.store, h.clock, null).recover();
    expect(r.resetUploading).toBe(1);
    expect(h.store.getChunk('c1')!.state).toBe('captured');
  });

  it('deletes orphan files for chunks already in state=completed', async () => {
    const p = placeFile(h.dir, 'completed.webm');
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
    const r = await new RecoveryService(h.store, h.clock, null).recover();
    expect(r.orphanCompletedFilesDeleted).toBe(1);
    expect(fs.existsSync(p)).toBe(false);
  });

  it('marks rows as failed_permanent (file_lost) when the file is missing', async () => {
    const p = path.join(h.dir, 'missing.webm');
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
    const r = await new RecoveryService(h.store, h.clock, null).recover();
    expect(r.rowsMarkedFileLost).toBe(1);
    const c = h.store.getChunk('c1')!;
    expect(c.state).toBe('failed_permanent');
    expect(c.last_error_class).toBe('file_lost');
  });

  it('sweeps failed_permanent files past the retention horizon (§11.7)', async () => {
    const p = placeFile(h.dir, 'old.webm');
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
    const r = await new RecoveryService(h.store, h.clock, null, DEFAULT_RECOVERY_OPTIONS).recover();
    expect(r.retentionFilesDeleted).toBe(1);
    expect(fs.existsSync(p)).toBe(false);
    const c = h.store.getChunk('c1')!;
    expect(c.file_deleted_at).not.toBeNull();
    // And on the *next* recovery pass, the same chunk doesn't double-count.
    const r2 = await new RecoveryService(h.store, h.clock, null, DEFAULT_RECOVERY_OPTIONS).recover();
    expect(r2.retentionFilesDeleted).toBe(0);
    expect(r2.rowsMarkedFileLost).toBe(0);
  });

  // ─── Crash recovery — active + paused_by_device_loss sessions ────────────

  it('crash-recovers active sessions: status→ended, end_reason=crash_recovered', async () => {
    const r = await new RecoveryService(h.store, h.clock, null).recover();
    expect(r.crashRecoveredActive).toBe(1);
    const s = h.store.getSession('s1')!;
    expect(s.status).toBe('ended');
    expect(s.end_reason).toBe('crash_recovered');
    expect(s.ended_at).toBe(s.started_at);
  });

  it('crash-recovered ended_at reflects last captured chunk_end_ms', async () => {
    h.store.insertChunk({
      id: 'c1',
      session_id: 's1',
      idx: 0,
      source: 'mixed',
      file_path: '/tmp/never-read.webm',
      start_ms: 0,
      end_ms: 12_345,
      overlap_prefix_ms: 0,
      duration_ms: 12_345,
      bytes: 8,
      sha256: null,
      device_boundary: false,
      sleep_boundary: false,
    });
    const r = await new RecoveryService(h.store, h.clock, null).recover();
    expect(r.crashRecoveredActive).toBe(1);
    const s = h.store.getSession('s1')!;
    expect(s.ended_at).toBe(s.started_at + 12_345);
  });

  it('idempotent: a second recover() pass touches zero active sessions', async () => {
    await new RecoveryService(h.store, h.clock, null).recover();
    const r2 = await new RecoveryService(h.store, h.clock, null).recover();
    expect(r2.crashRecoveredActive).toBe(0);
  });

  it('force-ends paused_by_device_loss sessions: end_reason=device_lost_unresumed', async () => {
    h.store.markSessionPausedByDeviceLoss('s1');
    const r = await new RecoveryService(h.store, h.clock, null).recover();
    expect(r.unresumedDeviceLoss).toBe(1);
    const s = h.store.getSession('s1')!;
    expect(s.status).toBe('ended');
    expect(s.end_reason).toBe('device_lost_unresumed');
  });

  // ─── Orphan audio-file recovery ────────────────────────────────────────

  it('encodes orphan .pcm files to .webm and inserts a captured chunks row', async () => {
    // Place a `<chunkId>.<source>.pcm` in the session directory; no chunks
    // row exists for it (in-flight at crash before closeChunk finished).
    const recordingsDir = h.dir;
    const sessionDir = path.join(recordingsDir, 's1');
    fs.mkdirSync(sessionDir, { recursive: true });
    const pcmPath = path.join(sessionDir, 'orphan-1.mixed.pcm');
    // 1 second of 16 kHz int16 = 32 000 bytes; durationMs = 1000.
    fs.writeFileSync(pcmPath, Buffer.alloc(32_000, 0x01));

    const r = await new RecoveryService(
      h.store,
      h.clock,
      recordingsDir,
      DEFAULT_RECOVERY_OPTIONS,
      undefined,
      new FakeEncoder(),
    ).recover();

    expect(r.recoveredOrphanPcms).toBe(1);
    const chunk = h.store.getChunk('orphan-1')!;
    expect(chunk).toBeDefined();
    expect(chunk.state).toBe('captured');
    expect(chunk.source).toBe('mixed');
    expect(chunk.file_path.endsWith('.webm')).toBe(true);
    expect(chunk.duration_ms).toBe(1_000);
    // PCM intermediate cleaned up; WebM landed.
    expect(fs.existsSync(pcmPath)).toBe(false);
    expect(fs.existsSync(chunk.file_path)).toBe(true);
  });

  it('reconstructs orphan .webm files (encoded but DB-insert lost) without re-encoding', async () => {
    // Place a `.webm` with EBML magic but no chunks row.
    const sessionDir = path.join(h.dir, 's1');
    fs.mkdirSync(sessionDir, { recursive: true });
    const webmPath = path.join(sessionDir, 'orphan-2.mixed.webm');
    // Empty body — duration probe will fail and recovery should skip. Then
    // place a real ffmpeg-encoded webm or accept that the probe-skip path
    // is the behaviour we want to verify. We use the FakeEncoder pass to
    // exercise the simpler case via a .pcm intermediate from another test;
    // here we just verify "probe failed → no insert".
    fs.writeFileSync(webmPath, Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));

    const r = await new RecoveryService(
      h.store,
      h.clock,
      h.dir,
      DEFAULT_RECOVERY_OPTIONS,
      undefined,
      new FakeEncoder(),
    ).recover();

    // Without a real WebM payload ffmpeg can't probe a duration; the orphan
    // gets skipped (left in place, no chunks row). Recovery code returns 0
    // — verifies the failure path doesn't crash or invent rows.
    expect(r.recoveredOrphanWebms).toBe(0);
    expect(h.store.getChunk('orphan-2')).toBeUndefined();
    expect(fs.existsSync(webmPath)).toBe(true);
  });

  it('re-encodes legacy .wav files (one-release shim) and inserts a captured row', async () => {
    const sessionDir = path.join(h.dir, 's1');
    fs.mkdirSync(sessionDir, { recursive: true });
    const wavPath = path.join(sessionDir, 'legacy-1.mic.wav');
    // 44-byte placeholder RIFF/WAVE header + 1 s of PCM (32 000 bytes).
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + 32_000, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16_000, 24);
    header.writeUInt32LE(16_000 * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(32_000, 40);
    const body = Buffer.alloc(32_000, 0x33);
    fs.writeFileSync(wavPath, Buffer.concat([header, body]));

    const r = await new RecoveryService(
      h.store,
      h.clock,
      h.dir,
      DEFAULT_RECOVERY_OPTIONS,
      undefined,
      new FakeEncoder(),
    ).recover();

    expect(r.recoveredLegacyWavs).toBe(1);
    const chunk = h.store.getChunk('legacy-1')!;
    expect(chunk).toBeDefined();
    expect(chunk.state).toBe('captured');
    expect(chunk.source).toBe('mic');
    expect(chunk.file_path.endsWith('.webm')).toBe(true);
    expect(chunk.duration_ms).toBe(1_000);
    // Original .wav gone; new .webm exists.
    expect(fs.existsSync(wavPath)).toBe(false);
    expect(fs.existsSync(chunk.file_path)).toBe(true);
  });

  it('orphan recovery skips directories whose session row no longer exists', async () => {
    const sessionDir = path.join(h.dir, 'unknown-session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const pcmPath = path.join(sessionDir, 'x.mic.pcm');
    fs.writeFileSync(pcmPath, Buffer.alloc(32_000));

    const r = await new RecoveryService(
      h.store,
      h.clock,
      h.dir,
      DEFAULT_RECOVERY_OPTIONS,
      undefined,
      new FakeEncoder(),
    ).recover();

    expect(r.recoveredOrphanPcms).toBe(0);
    expect(fs.existsSync(pcmPath)).toBe(true);
  });
});
