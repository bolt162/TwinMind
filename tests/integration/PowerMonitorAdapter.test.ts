import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { PowerMonitorAdapter, type PowerMonitorLike } from '@core/audio/PowerMonitorAdapter';
import { JobStore } from '@core/storage/JobStore';
import { MIGRATIONS } from '@core/storage/migrations';
import { prepareDatabase } from '@core/storage/Migrator';
import { FakeClock } from '@core/util/Clock';
import { ChunkWriter } from '@core/audio/ChunkWriter';
import { InMemoryAudioLink } from '@core/audio/AudioProcessLink';
import { RecordingOrchestrator } from '@core/audio/RecordingOrchestrator';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Fake powerMonitor backed by an EventEmitter so we can fire events manually. */
function fakePowerMonitor(): PowerMonitorLike & { fire: (e: 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen') => void } {
  const e = new EventEmitter();
  return {
    on(event, cb) {
      e.on(event, cb);
    },
    fire(event) {
      e.emit(event);
    },
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinmind-power-'));
  const db = new Database(':memory:');
  prepareDatabase(db, MIGRATIONS);
  const clock = new FakeClock(1_700_000_000_000);
  const store = new JobStore(db, clock);
  const writer = new ChunkWriter(store, clock, dir, { silenceThresholdDbfs: -50 });
  const link = new InMemoryAudioLink();
  const orchestrator = new RecordingOrchestrator({
    store,
    chunkWriter: writer,
    link,
    clock,
  });
  const pm = fakePowerMonitor();
  const adapter = new PowerMonitorAdapter({
    powerMonitor: pm,
    orchestrator,
    store,
  });
  return { dir, store, clock, orchestrator, link, pm, adapter };
}

function teardown(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('PowerMonitorAdapter', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => (h = setup()));
  afterEach(() => teardown(h.dir));

  it('pauses the active session on suspend (status=paused_by_sleep, ended_at=null)', () => {
    const sessionId = h.orchestrator.startMeeting();
    expect(h.orchestrator.state).toBe('recording');
    h.pm.fire('suspend');
    expect(h.orchestrator.state).toBe('idle');
    const row = h.store.getSession(sessionId)!;
    expect(row.status).toBe('paused_by_sleep');
    expect(row.ended_at).toBeNull();
  });

  it('emits a resume_prompt on wake', () => {
    h.orchestrator.startMeeting();
    h.pm.fire('suspend');
    const cb = vi.fn();
    h.adapter.onResumePrompt(cb);
    h.pm.fire('resume');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on lock-screen + unlock-screen', () => {
    h.orchestrator.startMeeting();
    h.pm.fire('lock-screen');
    expect(h.orchestrator.state).toBe('recording');
    h.pm.fire('unlock-screen');
    expect(h.orchestrator.state).toBe('recording');
  });
});
