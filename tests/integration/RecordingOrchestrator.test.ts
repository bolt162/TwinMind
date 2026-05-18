import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MIGRATIONS } from '@core/storage/migrations';
import { prepareDatabase } from '@core/storage/Migrator';
import { JobStore } from '@core/storage/JobStore';
import { FakeClock } from '@core/util/Clock';
import { ChunkWriter } from '@core/audio/ChunkWriter';
import { InMemoryAudioLink } from '@core/audio/AudioProcessLink';
import { RecordingOrchestrator } from '@core/audio/RecordingOrchestrator';
import type { AudioToMain, MainToAudio } from '@audio-process/protocol';

interface Harness {
  dir: string;
  clock: FakeClock;
  store: JobStore;
  link: InMemoryAudioLink;
  orchestrator: RecordingOrchestrator;
  writer: ChunkWriter;
}

function setup(vadDbfs = -50): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinmind-orch-'));
  const db = new Database(':memory:');
  prepareDatabase(db, MIGRATIONS);
  const clock = new FakeClock(1_700_000_000_000);
  const store = new JobStore(db, clock);
  const writer = new ChunkWriter(store, clock, dir, { silenceThresholdDbfs: vadDbfs });
  const link = new InMemoryAudioLink();
  const orchestrator = new RecordingOrchestrator({
    store,
    chunkWriter: writer,
    link,
    clock,
  });
  return { dir, clock, store, link, orchestrator, writer };
}

function teardown(h: Harness) {
  fs.rmSync(h.dir, { recursive: true, force: true });
}

/** Build a fake PcmFrame ArrayBuffer for a given amplitude. */
function makePcm(amplitude: number, samples = 1_600): ArrayBuffer {
  const arr = new Int16Array(samples);
  for (let i = 0; i < samples; i++) arr[i] = i % 2 === 0 ? amplitude : -amplitude;
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
}

/** Simulate audio-process sending one closed chunk worth of voiced data. */
function pretendAudioProcessSendsVoicedChunk(
  link: InMemoryAudioLink,
  chunkId: string,
  numFrames = 10,
  amplitude = 3_277,
): { sumSquares: number; sampleCount: number; bytes: number } {
  let sumSquares = 0;
  let sampleCount = 0;
  let bytes = 0;
  for (let i = 0; i < numFrames; i++) {
    const ab = makePcm(amplitude);
    const arr = new Int16Array(ab);
    for (const s of arr) sumSquares += s * s;
    sampleCount += arr.length;
    bytes += ab.byteLength;
    link.deliverFromAudio({
      type: 'pcm_frame',
      chunkId,
      pcm: ab,
      capturedAtMonoNs: String(i * 100_000_000),
      frameStartMs: i * 100,
    } as AudioToMain);
  }
  return { sumSquares, sampleCount, bytes };
}

describe('RecordingOrchestrator — dictation happy path', () => {
  let h: Harness;
  beforeEach(() => (h = setup()));
  afterEach(() => teardown(h));

  it('startDictation → audio-process gets start_session + open_chunk, session row exists', () => {
    const sessionId = h.orchestrator.startDictation();
    const sent = h.link.outbound as MainToAudio[];
    expect(sent[0]?.type).toBe('start_session');
    expect((sent[0] as { mode: string }).mode).toBe('dictation');
    expect(sent[1]?.type).toBe('open_chunk');
    expect(h.store.getSession(sessionId)?.status).toBe('active');
    expect(h.orchestrator.state).toBe('recording');
  });

  it('stop persists the chunk as captured and ends the session', () => {
    const sessionId = h.orchestrator.startDictation();
    const openMsg = h.link.outbound.find((m) => m.type === 'open_chunk') as
      | { chunkId: string }
      | undefined;
    expect(openMsg).toBeDefined();
    const chunkId = openMsg!.chunkId;

    const { sumSquares, sampleCount } = pretendAudioProcessSendsVoicedChunk(h.link, chunkId);
    h.orchestrator.stop();
    // audio-process responds with chunk_closed after close_chunk; deliver it.
    h.link.deliverFromAudio({ type: 'chunk_closed', chunkId, bytesWritten: 0, sumSquares, sampleCount });

    const chunks = h.store.listChunksForSession(sessionId);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.state).toBe('captured');
    expect(h.store.getSession(sessionId)!.status).toBe('ended');
  });
});

describe('RecordingOrchestrator — meeting chunk rotation', () => {
  let h: Harness;
  beforeEach(() => (h = setup()));
  afterEach(() => teardown(h));

  it('tickRotation closes current chunk and opens the next with 2s overlap', () => {
    h.orchestrator.startMeeting({ title: 'standup' });
    const beforeRotate = h.link.outbound.length;

    h.orchestrator.tickRotation();

    const since = h.link.outbound.slice(beforeRotate) as MainToAudio[];
    const close = since.find((m) => m.type === 'close_chunk') as
      | { chunkId: string; endMs: number }
      | undefined;
    const open = since.find((m) => m.type === 'open_chunk') as
      | { chunkId: string; startMs: number; overlapPrefixMs: number }
      | undefined;
    expect(close).toBeDefined();
    expect(open).toBeDefined();
    expect(open!.overlapPrefixMs).toBe(2_000);
    expect(close!.endMs).toBe(30_000);
    // chunk N+1 starts 2s before the prior chunk ended (overlap-prefix).
    expect(open!.startMs).toBe(28_000);
  });

  it('chunk_closed for a voiced chunk persists state=captured', () => {
    const sessionId = h.orchestrator.startMeeting();
    const openMsg = h.link.outbound.find((m) => m.type === 'open_chunk') as
      | { chunkId: string }
      | undefined;
    const chunkId = openMsg!.chunkId;

    const { sumSquares, sampleCount } = pretendAudioProcessSendsVoicedChunk(h.link, chunkId);
    h.orchestrator.tickRotation();
    h.link.deliverFromAudio({ type: 'chunk_closed', chunkId, bytesWritten: 0, sumSquares, sampleCount });

    const chunks = h.store.listChunksForSession(sessionId);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.state).toBe('captured');
    expect(chunks[0]!.source).toBe('mixed');
  });

  it('silent chunk takes the VAD-skip path → state=completed with empty transcript', () => {
    const sessionId = h.orchestrator.startMeeting();
    const openMsg = h.link.outbound.find((m) => m.type === 'open_chunk') as
      | { chunkId: string }
      | undefined;
    const chunkId = openMsg!.chunkId;

    // Push frames of silence so the WAV has bytes; then deliver chunk_closed
    // with sumSquares=0 to force VAD-skip.
    for (let i = 0; i < 5; i++) {
      h.link.deliverFromAudio({
        type: 'pcm_frame',
        chunkId,
        pcm: new ArrayBuffer(3_200),
        capturedAtMonoNs: '0',
        frameStartMs: i * 100,
      });
    }
    h.orchestrator.tickRotation();
    h.link.deliverFromAudio({
      type: 'chunk_closed',
      chunkId,
      bytesWritten: 5 * 3_200,
      sumSquares: 0,
      sampleCount: 5 * 1_600,
    });

    const chunks = h.store.listChunksForSession(sessionId);
    expect(chunks[0]!.state).toBe('completed');
    const t = h.store.getTranscript(chunks[0]!.id)!;
    expect(t.provider).toBe('local_vad');
    expect(t.text).toBe('');
    // WAV file was deleted on the VAD-skip path.
    expect(fs.existsSync(chunks[0]!.file_path)).toBe(false);
  });

  it('produces a sensible WAV file (44-byte header + PCM body) for captured chunks', () => {
    h.orchestrator.startMeeting();
    const openMsg = h.link.outbound.find((m) => m.type === 'open_chunk') as
      | { chunkId: string }
      | undefined;
    const chunkId = openMsg!.chunkId;

    const { sumSquares, sampleCount, bytes } = pretendAudioProcessSendsVoicedChunk(
      h.link,
      chunkId,
      5,
    );
    h.orchestrator.tickRotation();
    h.link.deliverFromAudio({ type: 'chunk_closed', chunkId, bytesWritten: bytes, sumSquares, sampleCount });

    const chunkRow = h.store.listChunksForSession(h.orchestrator.currentSessionId!)[0]!;
    const file = fs.readFileSync(chunkRow.file_path);
    expect(file.length).toBe(44 + bytes);
    expect(file.toString('ascii', 0, 4)).toBe('RIFF');
  });
});

describe('RecordingOrchestrator — refuses re-entrant start', () => {
  let h: Harness;
  beforeEach(() => (h = setup()));
  afterEach(() => teardown(h));

  it('throws if a session is already active', () => {
    h.orchestrator.startMeeting();
    expect(() => h.orchestrator.startMeeting()).toThrow();
    expect(() => h.orchestrator.startDictation()).toThrow();
  });
});
