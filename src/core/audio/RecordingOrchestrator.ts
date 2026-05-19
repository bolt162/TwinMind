/**
 * RecordingOrchestrator — top-level FSM that drives a recording session.
 *
 * Architecture: §5 (Orchestrator owns "hotkey/IPC/meeting-detect → start/stop
 * calls into AudioCaptureService, manages session lifecycle"), §7 (audio
 * subsystem), §7.10 (sleep), §7.11 (VAD via ChunkWriter).
 *
 * State machine:
 *   idle → starting → recording → stopping → idle
 *
 * Public surface (called from IPC, hotkey, meeting-detect):
 *   startDictation() / startMeeting({ title? }) → sessionId
 *   stop()
 *   handleAudioMessage(msg)  — wired by AudioProcessLink.on
 *
 * Internal driver:
 *   The audio-process emits `rotation_due` once the current chunk has
 *   accumulated `chunkRotationIntervalMs()` of NEW audio (overlap prepend
 *   excluded), measured on the audio clock — not wall-clock. We respond by
 *   closing the current chunk and opening the next one with a 2 s
 *   overlap-prefix, which the audio-process populates from its rolling tail.
 *
 * Crash safety: every state change persists through JobStore before any user
 * acknowledgement. A killed process at any point leaves recoverable rows
 * (§11.5) — the orchestrator never trusts in-memory state at next launch.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import type { ChunkWriter } from './ChunkWriter';
import type { ModeBehavior } from './modes/ModeBehavior';
import { DictationModeBehavior } from './modes/DictationModeBehavior';
import { MeetingModeBehavior } from './modes/MeetingModeBehavior';
import type { AudioProcessLink } from './AudioProcessLink';
import type { JobStore } from '@core/storage/JobStore';
import type { Clock } from '@core/util/Clock';
import { type Logger, noopLogger } from '@core/observability/Logger';
import type { AudioToMain } from '@audio-process/protocol';

export type OrchestratorState = 'idle' | 'starting' | 'recording' | 'stopping';

/** Renderer-facing snapshot emitted via the `state_changed` event. */
export interface OrchestratorStateChange {
  readonly state: OrchestratorState;
  readonly mode: 'idle' | 'dictation' | 'meeting';
  readonly sessionId: string | null;
  readonly elapsedMs: number;
}

export interface RecordingOrchestratorDeps {
  readonly store: JobStore;
  readonly chunkWriter: ChunkWriter;
  readonly link: AudioProcessLink;
  readonly clock: Clock;
  readonly logger?: Logger;
}

interface ActiveSession {
  readonly sessionId: string;
  readonly mode: 'dictation' | 'meeting';
  readonly behavior: ModeBehavior;
  readonly startedAt: number;
  chunkIdx: number;
  /** The chunk currently open in audio-process (and ChunkWriter). */
  currentChunkId: string;
  currentChunkStartMs: number;
  /**
   * Overlap-prefix that was prepended to the current chunk's file. Needed so
   * tickRotation can compute the true end-of-new-content for this chunk —
   * `endMs = currentChunkStartMs + currentChunkOverlapMs + new-audio-target`.
   * Without this, every chunk after the first would drift 2 s earlier than
   * the audio-clock-driven rotation actually fires.
   */
  currentChunkOverlapMs: number;
}

export class RecordingOrchestrator {
  private readonly store: JobStore;
  private readonly chunkWriter: ChunkWriter;
  private readonly link: AudioProcessLink;
  private readonly clock: Clock;
  private readonly logger: Logger;

  private stateInternal: OrchestratorState = 'idle';
  private active: ActiveSession | null = null;
  private readonly emitter = new EventEmitter();
  /**
   * Set by mic_rebound; consumed by the next beginChunk so the chunk row is
   * stamped with device_boundary=true. Cleared after use. Persists across
   * the rebind→next-rotation gap because beginChunk is the only place we
   * actually need it — there's no per-chunk update path otherwise.
   */
  private pendingDeviceBoundary = false;

  /** Construct with deps; subscribes to AudioProcessLink for audio events. */
  constructor(deps: RecordingOrchestratorDeps) {
    this.store = deps.store;
    this.chunkWriter = deps.chunkWriter;
    this.link = deps.link;
    this.clock = deps.clock;
    this.logger = deps.logger ?? noopLogger;
    this.link.on((msg) => this.handleAudioMessage(msg));
  }

  /**
   * Subscribe to `state_changed` events. Fires whenever the FSM transitions
   * (idle → starting → recording → stopping → idle). The composition root
   * forwards these to the renderer via `IpcBridgeMain.broadcast`.
   */
  on(event: 'state_changed', cb: (change: OrchestratorStateChange) => void): void {
    this.emitter.on(event, cb);
  }

  /** Snapshot the current state for broadcast. */
  snapshot(): OrchestratorStateChange {
    const a = this.active;
    return {
      state: this.stateInternal,
      mode: a?.mode ?? 'idle',
      sessionId: a?.sessionId ?? null,
      elapsedMs: a ? this.clock.now() - a.startedAt : 0,
    };
  }

  /** Internal helper: set state and emit the change event. */
  private setState(next: OrchestratorState): void {
    this.stateInternal = next;
    this.emitter.emit('state_changed', this.snapshot());
  }

  /** Current FSM state. */
  get state(): OrchestratorState {
    return this.stateInternal;
  }

  /** Active session id (if any). */
  get currentSessionId(): string | null {
    return this.active?.sessionId ?? null;
  }

  // ─── Public start/stop ───────────────────────────────────────────────────

  /** Start a dictation session; returns the new sessionId. */
  startDictation(opts: { title?: string } = {}): string {
    return this.startSession('dictation', new DictationModeBehavior(), opts.title ?? null);
  }

  /** Start a meeting session; returns the new sessionId. */
  startMeeting(opts: { title?: string } = {}): string {
    return this.startSession('meeting', new MeetingModeBehavior(), opts.title ?? null);
  }

  /** Stop the active session. Closes the current chunk, ends the session. */
  stop(reason: string = 'user'): void {
    if (!this.active || this.stateInternal === 'stopping') return;
    const elapsed = this.clock.now() - this.active.startedAt;
    // Phantom-cancel path: the user released the hotkey so fast that there's
    // effectively no recording. Don't persist anything — delete the session
    // row (CASCADE-drops chunks/transcripts that haven't been inserted yet
    // anyway), abort the in-progress WAV writer, and skip the chunk_closed
    // round-trip with audio-process. The eventual chunk_closed (which may
    // arrive seconds later if the native mic engine is slow) is harmless:
    // ChunkWriter.closeChunk will throw on unknown-chunkId (the abort path
    // removed it from active), which the orchestrator's audioLink hook
    // already catches and ignores.
    if (reason === 'user' && elapsed < RecordingOrchestrator.PHANTOM_HOLD_THRESHOLD_MS) {
      this.cancelPhantom(elapsed);
      return;
    }
    this.setState('stopping');
    const a = this.active;

    // Send close_chunk; audio-process will reply with chunk_closed which the
    // handler below routes to ChunkWriter.closeChunk. Send stop_session after
    // so audio-process tears down capture sources cleanly.
    const endMs = this.clock.now() - a.startedAt;
    this.link.send({ type: 'close_chunk', chunkId: a.currentChunkId, endMs });
    this.link.send({ type: 'stop_session' });

    this.store.endSession(a.sessionId, this.clock.now(), reason);
    this.logger.info('session stopped', { sessionId: a.sessionId, reason });
    this.active = null;
    this.setState('idle');
  }

  /**
   * Holds shorter than this trigger the phantom-cancel path: no DB rows,
   * no WAV file, no upload, no spinner. Matches the threshold the HUD
   * uses in TranscriptionUx — both layers gate at the same boundary so
   * they always agree on what counts as a phantom.
   */
  private static readonly PHANTOM_HOLD_THRESHOLD_MS = 500;

  /**
   * Tear down an active session as if it never happened. Used for
   * accidental hotkey hair-triggers; see `stop()` for the gating logic.
   */
  private cancelPhantom(elapsedMs: number): void {
    if (!this.active) return;
    const a = this.active;
    this.setState('stopping');
    // Tear down audio-process capture; no close_chunk because we're discarding
    // the chunk locally rather than persisting it.
    this.link.send({ type: 'stop_session' });
    // Drop the in-progress WAV file + writer state.
    this.chunkWriter.abortChunk(a.currentChunkId);
    // CASCADE: deleting the session removes the (not-yet-inserted) chunks
    // and transcripts referencing it.
    this.store.deleteSession(a.sessionId);
    this.logger.info('session cancelled (phantom hold)', {
      sessionId: a.sessionId,
      elapsedMs,
    });
    this.active = null;
    this.setState('idle');
  }

  /**
   * Suspend the active session for sleep (§7.10). Closes the current chunk,
   * tears down audio-process, marks the session `paused_by_sleep` (NOT ended,
   * so it can be resumed within the 30 min window). Returns the sessionId so
   * the caller can show a resume prompt on wake.
   */
  pauseForSleep(): string | null {
    if (!this.active || this.stateInternal !== 'recording') return null;
    this.setState('stopping');
    const a = this.active;

    const endMs = this.clock.now() - a.startedAt;
    this.link.send({ type: 'close_chunk', chunkId: a.currentChunkId, endMs });
    this.link.send({ type: 'stop_session' });

    // Mark paused_by_sleep BEFORE clearing local state, so a crash mid-suspend
    // still leaves a session row the recovery sweep can reason about (§11.5).
    try {
      this.store.markSessionPausedBySleep(a.sessionId);
    } catch (e) {
      this.logger.warn('markSessionPausedBySleep failed', { err: String(e) });
    }
    this.logger.info('session paused by sleep', { sessionId: a.sessionId });
    const sid = a.sessionId;
    this.active = null;
    this.setState('idle');
    return sid;
  }

  // ─── Message routing from audio-process ──────────────────────────────────

  /**
   * Public for tests; production code subscribes via the link in the
   * constructor. PCM frames go straight to ChunkWriter; chunk_closed kicks
   * off the persistence + rotation logic.
   */
  handleAudioMessage(msg: AudioToMain): void {
    switch (msg.type) {
      case 'pcm_frame':
        // ArrayBuffer arrives over the port; wrap as Buffer for fs writeSync.
        this.chunkWriter.appendPcm(msg.chunkId, Buffer.from(msg.pcm));
        return;
      case 'chunk_closed':
        this.onChunkClosed(msg.chunkId, msg.sumSquares, msg.sampleCount);
        return;
      case 'device_change':
        // The audio-process logs and starts its rebind path on this event;
        // we just record telemetry. The boundary marker is set on the
        // mic_rebound message (below) because device_change can fire many
        // times in a noisy disconnect, while mic_rebound is one-per-rebind.
        this.logger.info('audio device change', { kind: msg.kind, label: msg.label });
        return;
      case 'mic_rebound':
        // Mic was successfully restarted against the new system default.
        // Mark the NEXT chunk to be opened with device_boundary=true so the
        // transcription doesn't try to splice across the cutover.
        this.pendingDeviceBoundary = true;
        this.logger.info('mic rebound; next chunk will carry device_boundary');
        return;
      case 'capture_error':
        this.logger.error('capture error', { source: msg.source, message: msg.message });
        // Don't auto-stop; a transient mic disconnect can recover via
        // device_change. Stop only on user action or hard FSM failure.
        return;
      case 'ready':
        return;
      case 'amplitude_sample':
        // Passed through by main.ts directly to the HUD via a push channel;
        // the orchestrator doesn't need it for FSM state.
        return;
      case 'rotation_due':
        // Audio-clock-driven chunk rotation: the audio-process tells us the
        // current chunk has accumulated CHUNK_NEW_AUDIO_MS of new audio (not
        // counting overlap prepend). We respond with the standard
        // close + open dance. Replaces the old wall-clock setInterval, which
        // produced 29/31/28 s chunks under scheduler jitter or BT gaps.
        if (this.active?.behavior.enableChunkRotation) this.tickRotation();
        return;
    }
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  /** Create the session row, kick off the audio-process, open chunk 0. */
  private startSession(
    mode: 'dictation' | 'meeting',
    behavior: ModeBehavior,
    title: string | null,
  ): string {
    if (this.stateInternal !== 'idle' || this.active) {
      throw new Error(`cannot start ${mode}: orchestrator state is ${this.stateInternal}`);
    }
    this.setState('starting');

    const sessionId = randomUUID();
    const startedAt = this.clock.now();
    this.store.createSession({
      id: sessionId,
      mode,
      started_at: startedAt,
      title,
    });

    this.link.send({
      type: 'start_session',
      sessionId,
      mode,
      enableSystemAudio: behavior.enableSystemAudio,
      sampleRate: 16_000,
    });

    const chunkId = randomUUID();
    const chunkStartMs = 0;
    this.chunkWriter.beginChunk({
      chunkId,
      sessionId,
      idx: 0,
      source: mode === 'dictation' ? 'mic' : 'mixed',
      startMs: chunkStartMs,
      overlapPrefixMs: 0,
      deviceBoundary: false,
      sleepBoundary: false,
    });
    this.link.send({
      type: 'open_chunk',
      chunkId,
      startMs: chunkStartMs,
      overlapPrefixMs: 0,
    });

    this.active = {
      sessionId,
      mode,
      behavior,
      startedAt,
      chunkIdx: 0,
      currentChunkId: chunkId,
      currentChunkStartMs: chunkStartMs,
      currentChunkOverlapMs: 0,
    };
    this.setState('recording');
    this.logger.info('session started', { sessionId, mode });
    return sessionId;
  }

  /**
   * Close the current chunk and open the next one. Public for tests; production
   * triggers it from the `rotation_due` message emitted by the audio-process
   * once a chunk has accumulated `chunkRotationIntervalMs()` of new audio.
   */
  tickRotation(): void {
    if (!this.active || this.stateInternal !== 'recording') return;
    const a = this.active;
    const elapsed = this.clock.now() - a.startedAt;
    if (a.behavior.shouldForceStop(elapsed, { sessionStartedAt: a.startedAt, chunkIdx: a.chunkIdx })) {
      this.stop('force_cap');
      return;
    }

    // True end of NEW audio for the current chunk:
    //   startMs of chunk + overlap that was prepended at its open + the
    //   chunkRotationIntervalMs() worth of fresh content the audio-process
    //   accumulated before emitting `rotation_due`. The previous version
    //   omitted `currentChunkOverlapMs`, which drifted every chunk after the
    //   first two seconds earlier than the timeline displayed in the HUD.
    const endMs =
      a.currentChunkStartMs + a.currentChunkOverlapMs + a.behavior.chunkRotationIntervalMs();
    this.link.send({ type: 'close_chunk', chunkId: a.currentChunkId, endMs });
    // audio-process replies with chunk_closed; we open the next chunk eagerly
    // here so the open_chunk message arrives in order. The 2 s overlap is
    // populated by the audio-process's rolling tail when overlapPrefixMs > 0.

    const nextIdx = a.chunkIdx + 1;
    const overlap = a.behavior.nextChunkOverlapMs(nextIdx);
    const nextStartMs = endMs - overlap;
    const nextChunkId = randomUUID();

    this.chunkWriter.beginChunk({
      chunkId: nextChunkId,
      sessionId: a.sessionId,
      idx: nextIdx,
      source: a.mode === 'dictation' ? 'mic' : 'mixed',
      startMs: nextStartMs,
      overlapPrefixMs: overlap,
      deviceBoundary: this.pendingDeviceBoundary,
      sleepBoundary: false,
    });
    this.pendingDeviceBoundary = false;
    this.link.send({
      type: 'open_chunk',
      chunkId: nextChunkId,
      startMs: nextStartMs,
      overlapPrefixMs: overlap,
    });

    a.chunkIdx = nextIdx;
    a.currentChunkId = nextChunkId;
    a.currentChunkStartMs = nextStartMs;
    a.currentChunkOverlapMs = overlap;
  }

  /**
   * Forward to ChunkWriter, which knows per-chunk metadata (start_ms etc.)
   * from `beginChunk` and computes `end_ms` from the WAV's own duration. This
   * intentionally does NOT check `this.active`: a chunk_closed can legitimately
   * arrive after stop() (the audio-process drains its mixer before tearing
   * down), and we still want to finalize that chunk.
   */
  private onChunkClosed(chunkId: string, sumSquares: number, sampleCount: number): void {
    this.chunkWriter.closeChunk({ chunkId, sumSquares, sampleCount });
  }
}
