/**
 * TranscriptionUx — UI state machine for upload retry surfaces.
 *
 * Drives three things on top of the UploadQueue's chunk lifecycle:
 *   1. `PUSH.TRANSCRIPTION_UI_STATE` to the HUD (idle / retrying / failed).
 *   2. One OS notification per session that has any retryable permanent
 *      failure (debounced via `notifiedSessions` until the user clicks
 *      Retry on that session).
 *   3. The "Open TwinMind" click action on the notification, which brings
 *      the main window forward and switches to the Sessions tab.
 *
 * State transitions (recording-state is independent; HUD prioritises the
 * waveform during recording):
 *   idle            → failed{sid}      on chunk_failed_permanent of a
 *                                      retryable error class
 *   failed{sid}     → retrying         on user-clicked Retry for `sid`
 *   retrying        → idle / failed    once every chunk reset by the most
 *                                      recent retry batch has resolved
 *   any             → failed{sid'}     on a fresh permanent failure during
 *                                      retrying or while already failed
 *
 * Only retryable classes ('network', 'timeout', 'rate_limit', 'server_5xx',
 * 'unknown') drive the failed state — we never surface a Retry for auth or
 * bad-audio failures, those would just fail again.
 */

import type { JobStore } from '@core/storage/JobStore';
import type { TranscriptionUiState } from '@ipc/channels';
import type { INotificationService } from '@platform/INotificationService';

/** What main.ts hands us so we can broadcast + open windows. */
export interface TranscriptionUxDeps {
  readonly store: JobStore;
  readonly notifications: INotificationService;
  /** Broadcast the current UI state to the HUD. */
  readonly broadcastToHud: (state: TranscriptionUiState) => void;
  /** Bring the main window forward and switch to the Sessions tab. */
  readonly openSessionsTab: () => void;
  /**
   * Optional: fires the moment every chunk of `sessionId` has reached a
   * terminal state (completed / failed_permanent). main.ts uses this to
   * kick off the per-meeting summary call — by this point the backend
   * already has every successful transcript chunk keyed by sessionId.
   */
  readonly onSessionProcessed?: (sessionId: string) => void;
}

const RETRYABLE_CLASSES = new Set([
  'network',
  'timeout',
  'rate_limit',
  'server_5xx',
  'unknown',
]);

export class TranscriptionUx {
  private state: TranscriptionUiState = { kind: 'idle' };
  /** Sessions that have already shown one toast — cleared on user retry. */
  private readonly notifiedSessions = new Set<string>();
  /** Chunks reset by the most recent retry click; cleared as each finishes. */
  private readonly retryBatch = new Set<string>();
  /**
   * Sessions whose initial uploads (after recording stop) are still in
   * flight. Added on the orchestrator's stop transition; removed when every
   * chunk of the session reaches a terminal state (completed or failed_perm).
   * Either this OR `retryBatch` non-empty puts the HUD into 'processing'.
   */
  private readonly processingSessions = new Set<string>();
  /**
   * Per-session watchdog timers. Schedule on onRecordingStopped; cancel when
   * the session drains normally. If a timer fires while its session is still
   * in `processingSessions`, force-drain it so the HUD doesn't stay stuck on
   * the spinner. Defensive: covers any failure mode where chunk_closed never
   * arrives or no chunk_completed/chunk_failed_permanent event ever fires.
   */
  private readonly processingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * How long to wait after a recording stops before force-draining the
   * processing state. Set generously to 30 s so that slow networks /
   * backend latency don't race the watchdog and silently veto the paste
   * path — when the watchdog drains `processingSessions` before
   * chunk_completed arrives, `maybeFinishSession`'s gate short-circuits
   * and `onSessionProcessed` (the trigger for dictation paste + meeting
   * summary) never fires. QA on a MacBook Air was hitting this at
   * 10 s. 30 s leaves room for genuinely slow uploads while still
   * catching real stuck-state bugs in a bounded window.
   *
   * If we ever see this fire on a real network again, the proper fix is
   * to separate the HUD-spinner state from the "owe a callback" state
   * (see WIP design notes — they share `processingSessions` today).
   */
  private static readonly PROCESSING_WATCHDOG_MS = 30_000;
  /**
   * Sessions whose total wall-clock duration is below this threshold are
   * treated as phantoms — typically a too-quick hotkey release where the
   * native mic engine hadn't even delivered its first PCM frame. We skip
   * the entire processing-state machinery so the HUD doesn't sit on the
   * spinner waiting for a chunk_closed that's either empty or stuck.
   */
  private static readonly PHANTOM_HOLD_THRESHOLD_MS = 500;
  /**
   * The session that the HUD's failed state is currently bound to. Only set
   * by failures that occur during *this* app run; past failures left in the
   * DB from previous runs never appear here. Cleared by:
   *   • a successful retry that drains the session's failed chunks,
   *   • the user dismissing the HUD via the History button.
   */
  private currentFailedSessionId: string | null = null;
  /**
   * Set when the dictation 5-min hard cap fires (RecordingOrchestrator emits
   * `dictation_limit_reached`). Holds the sessionId that was force-stopped
   * so the HUD banner can reference it. Cleared by Dismiss or Dictate —
   * both come in through onDictationLimitDismissed. Highest visual priority
   * in `recompute()` so the prompt is unmissable (overrides 'processing'
   * even though the just-stopped session's chunks may still be uploading
   * in the background; those continue and paste when done).
   */
  private dictationLimitSessionId: string | null = null;

  constructor(private readonly deps: TranscriptionUxDeps) {}

  /**
   * Hook into `uploadQueue.on('chunk_failed_permanent')`. Only retryable
   * classes flip the UX; auth/bad-audio failures stay silent here. The
   * notification dedupe is per-session: we add to `notifiedSessions` and
   * only show again after the user actually clicks Retry on that session.
   */
  onChunkFailedPermanent(chunkId: string, errorClass: string): void {
    // Always remove from the retry batch — whether or not the failure is
    // retryable, the retry attempt for this chunk is over.
    this.retryBatch.delete(chunkId);

    const chunk = this.deps.store.getChunk(chunkId);
    if (chunk) this.maybeFinishSession(chunk.session_id);

    if (!RETRYABLE_CLASSES.has(errorClass)) {
      this.recompute();
      return;
    }
    if (!chunk) {
      this.recompute();
      return;
    }
    const sessionId = chunk.session_id;

    // Bind the HUD's failed state to *this* session. Most-recent wins if
    // multiple sessions fail in a row.
    this.currentFailedSessionId = sessionId;

    if (!this.notifiedSessions.has(sessionId)) {
      this.notifiedSessions.add(sessionId);
      this.showNotification(sessionId);
    }

    this.recompute();
  }

  /** Hook into `uploadQueue.on('chunk_completed')`. */
  onChunkCompleted(chunkId: string): void {
    this.retryBatch.delete(chunkId);
    const chunk = this.deps.store.getChunk(chunkId);
    if (chunk) this.maybeFinishSession(chunk.session_id);
    // If the session that the HUD is bound to has drained its failures, clear
    // it. New failures (handled in onChunkFailedPermanent) re-bind.
    if (
      this.currentFailedSessionId !== null &&
      this.deps.store.countFailedChunks(this.currentFailedSessionId) === 0
    ) {
      this.notifiedSessions.delete(this.currentFailedSessionId);
      this.currentFailedSessionId = null;
    }
    this.recompute();
  }

  /**
   * Called by main.ts when the orchestrator transitions from recording to
   * idle. We immediately enter 'processing' state (optimistic — better to
   * show the spinner for a few ms than miss it entirely) and the
   * onChunkPersisted/onChunkCompleted/onChunkFailedPermanent paths drain the
   * set as chunks resolve.
   */
  onRecordingStopped(sessionId: string, elapsedMs: number): void {
    // Phantom-session gate. When a user releases the hotkey so fast that
    // the native mic engine hadn't yet produced its first frame (typical
    // accidental press: <500ms of total wall time), entering processing
    // state just makes the HUD spin until the audio-process dispatch queue
    // eventually drains start_session — sometimes 3-5s on a slow mic
    // engine — for an audibly empty chunk we don't care about. Skip the
    // whole machinery; the eventual chunk_closed will be a no-op against
    // an empty processingSessions set.
    if (elapsedMs < TranscriptionUx.PHANTOM_HOLD_THRESHOLD_MS) {
      // Use console for visibility without threading a logger dependency in.
      // Drop once tuned.
      console.info(
        `[transcription_ux] phantom stop ignored sessionId=${sessionId} elapsedMs=${elapsedMs}`,
      );
      return;
    }
    this.processingSessions.add(sessionId);
    // Watchdog: if chunk_closed never arrives or the chunks never reach a
    // terminal state, the HUD would stay on the spinner forever. The audio
    // process is supposed to always emit chunk_closed (see AudioGraph), but
    // any race in the chain — main → port → audio-process → port → main →
    // ChunkWriter — could in principle drop the reply. This timer is the
    // last line of defense.
    const existing = this.processingTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.processingTimers.set(
      sessionId,
      setTimeout(() => {
        this.processingTimers.delete(sessionId);
        if (this.processingSessions.has(sessionId)) {
          this.processingSessions.delete(sessionId);
          this.recompute();
        }
      }, TranscriptionUx.PROCESSING_WATCHDOG_MS),
    );
    this.recompute();
  }

  /**
   * Called by main.ts when a `chunk_closed` message arrives from the audio
   * process (which has just been turned into a DB row by ChunkWriter). This
   * is the only signal that the *last* chunk of a recording has reached the
   * DB — needed because the orchestrator's "stopping → idle" transition
   * fires BEFORE chunk_closed for the final chunk arrives. Also catches
   * VAD-skipped chunks (those don't go through UploadQueue at all so they
   * never fire chunk_completed).
   */
  onChunkPersisted(sessionId: string): void {
    this.maybeFinishSession(sessionId);
    this.recompute();
  }

  /** Convenience predicate for main.ts to gate recording-start paths. */
  isBlockingNewRecording(): boolean {
    return this.state.kind === 'processing';
  }

  /**
   * Called when the user dismisses the HUD via the History button. We treat
   * this as acknowledgment: clear the HUD's tracked session so it goes back
   * to idle, even though the chunks remain in `failed_permanent` in the DB.
   * The session is still reachable (and retryable) from the Sessions tab.
   */
  onHistoryDismissed(): void {
    this.currentFailedSessionId = null;
    this.recompute();
  }

  /**
   * Called from main.ts when RecordingOrchestrator emits
   * `dictation_limit_reached` (the 5-min cap fired). Sets the HUD to the
   * highest-priority banner state so the user sees the prompt immediately.
   */
  onDictationLimitReached(sessionId: string): void {
    this.dictationLimitSessionId = sessionId;
    this.recompute();
  }

  /**
   * Called by the Dismiss or Dictate button (REC_DICTATION_LIMIT_DISMISS).
   * Clears the limit banner; recompute lands on whatever underlying state
   * is still true (processing if chunks still in flight, idle otherwise).
   */
  onDictationLimitDismissed(): void {
    this.dictationLimitSessionId = null;
    this.recompute();
  }

  /**
   * Called from the SESSION_RETRY_FAILED IPC handler AFTER the JobStore
   * reset. `chunkIds` is the list of chunks that were just reset to
   * `captured` — we track them so the 'retrying' state ends exactly when
   * the queue has resolved every one (either to completed or back to
   * failed_permanent).
   */
  onRetryRequested(sessionId: string, chunkIds: ReadonlyArray<string>): void {
    // Allow this session to notify again if its retry fails permanently.
    this.notifiedSessions.delete(sessionId);
    for (const id of chunkIds) this.retryBatch.add(id);
    this.recompute();
  }

  /** Test/diagnostic accessor. */
  currentState(): TranscriptionUiState {
    return this.state;
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  /**
   * Single source of truth. The HUD's failed state is bound to
   * `currentFailedSessionId` — we never read the DB for "any failures
   * anywhere", so past failures from previous runs stay invisible to the HUD
   * (they're still accessible via the Sessions tab).
   *
   *   dictationLimitSessionId set                          → 'dictation_limit_reached'
   *   retryBatch OR processingSessions non-empty           → 'processing'
   *   currentFailedSessionId set + still has failures      → 'failed' for it
   *   otherwise                                            → 'idle'
   *
   * `dictation_limit_reached` outranks `processing` deliberately: the
   * prompt needs to be unmissable. Background chunk-completion of the
   * just-stopped session keeps running and pastes on the existing path
   * when ready, regardless of the banner being up.
   */
  private recompute(): void {
    if (this.dictationLimitSessionId !== null) {
      this.setState({ kind: 'dictation_limit_reached', sessionId: this.dictationLimitSessionId });
      return;
    }
    if (this.retryBatch.size > 0 || this.processingSessions.size > 0) {
      this.setState({ kind: 'processing' });
      return;
    }
    if (
      this.currentFailedSessionId !== null &&
      this.deps.store.countFailedChunks(this.currentFailedSessionId) > 0
    ) {
      this.setState({ kind: 'failed', sessionId: this.currentFailedSessionId });
      return;
    }
    this.setState({ kind: 'idle' });
  }

  /**
   * If `sessionId` is in the processing set and every one of its chunks has
   * reached a terminal state, remove it. We treat `rows.length === 0` as
   * "still racing the last chunk_closed" and keep the session in the set;
   * the next chunk lifecycle event will re-check.
   */
  private maybeFinishSession(sessionId: string): void {
    if (!this.processingSessions.has(sessionId)) return;
    const rows = this.deps.store.listChunksForSession(sessionId);
    if (rows.length === 0) return;
    const allTerminal = rows.every(
      (c) => c.state === 'completed' || c.state === 'failed_permanent',
    );
    if (allTerminal) {
      this.processingSessions.delete(sessionId);
      // Cancel the per-session watchdog: normal drain happened in time, no
      // need for the fallback to fire later.
      const timer = this.processingTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        this.processingTimers.delete(sessionId);
      }
      // Notify the outer wiring (e.g. summary auto-trigger). Wrapped so a
      // throwing callback can't poison TranscriptionUx's invariants.
      if (this.deps.onSessionProcessed) {
        try {
          this.deps.onSessionProcessed(sessionId);
        } catch {
          /* listener bug — swallow */
        }
      }
    }
  }

  /** Broadcast only on transitions to avoid spamming the HUD on each chunk. */
  private setState(next: TranscriptionUiState): void {
    if (statesEqual(this.state, next)) return;
    this.state = next;
    this.deps.broadcastToHud(next);
  }

  private showNotification(sessionId: string): void {
    const session = this.deps.store.getSession(sessionId);
    const label =
      session?.title ??
      (session?.mode === 'meeting' ? 'a meeting' : 'a dictation');
    this.deps.notifications.show(
      {
        title: 'Transcription failed',
        body: `Couldn't transcribe parts of "${label}". Open TwinMind to retry.`,
        actions: [{ id: 'open', label: 'Open' }],
        autoDismissMs: 30_000,
      },
      (action) => {
        if (action === 'open') this.deps.openSessionsTab();
      },
    );
  }
}

function statesEqual(a: TranscriptionUiState, b: TranscriptionUiState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'failed' && b.kind === 'failed') return a.sessionId === b.sessionId;
  if (a.kind === 'dictation_limit_reached' && b.kind === 'dictation_limit_reached') {
    return a.sessionId === b.sessionId;
  }
  return true;
}
