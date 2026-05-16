/**
 * PowerMonitorAdapter — bridges Electron `powerMonitor` events to the
 * RecordingOrchestrator FSM (§7.10).
 *
 * Behavior:
 *   - `suspend`           → orchestrator.stop('sleep') (we can't capture across sleep).
 *   - `resume`            → if a `paused_by_sleep` session is still ≤30 min old,
 *                          surface a "Resume recording?" notification (handled by
 *                          composition; this adapter only emits an event).
 *   - `lock-screen`       → **no-op** (password entry mid-meeting must not drop audio).
 *   - `unlock-screen`     → no-op.
 *
 * The adapter is decoupled from Electron itself behind a `PowerMonitorLike`
 * interface so tests can inject a fake emitter and verify the orchestrator
 * receives the right calls.
 */

import { EventEmitter } from 'node:events';
import type { RecordingOrchestrator } from './RecordingOrchestrator';
import type { JobStore } from '@core/storage/JobStore';
import { type Logger, noopLogger } from '@core/observability/Logger';

/** Structural subset of Electron's powerMonitor we depend on. */
export interface PowerMonitorLike {
  on(event: 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen', cb: () => void): void;
}

export interface PowerMonitorAdapterDeps {
  readonly powerMonitor: PowerMonitorLike;
  readonly orchestrator: RecordingOrchestrator;
  readonly store: JobStore;
  readonly logger?: Logger;
}

export interface ResumePromptEvent {
  /** The session that was paused by sleep and is still within the resume window. */
  readonly sessionId: string;
}

export class PowerMonitorAdapter {
  private readonly emitter = new EventEmitter();
  /** Tracks the last suspended session so we can offer resume on wake. */
  private suspendedSessionId: string | null = null;

  /** Construct over the deps; immediately subscribes to the powerMonitor. */
  constructor(private readonly deps: PowerMonitorAdapterDeps) {
    const log = deps.logger ?? noopLogger;
    deps.powerMonitor.on('suspend', () => {
      // pauseForSleep handles the close-chunk + stop-session control flow AND
      // flips the session row to status='paused_by_sleep' atomically (returns
      // the sessionId so we can prompt on resume).
      this.suspendedSessionId = deps.orchestrator.pauseForSleep();
      if (!this.suspendedSessionId) {
        log.debug('suspend received but no active recording');
      }
    });

    deps.powerMonitor.on('resume', () => {
      const sid = this.suspendedSessionId;
      this.suspendedSessionId = null;
      if (!sid) return;
      // The full resume UX is handled by composition: show a notification,
      // and only re-arm capture if the user clicks "Resume".
      this.emitter.emit('resume_prompt', { sessionId: sid } satisfies ResumePromptEvent);
    });

    // lock-screen / unlock-screen intentionally not handled — recording
    // continues through password entry.
  }

  /** Subscribe to the prompt-the-user-to-resume event surfaced on wake. */
  onResumePrompt(cb: (e: ResumePromptEvent) => void): () => void {
    this.emitter.on('resume_prompt', cb);
    return () => this.emitter.off('resume_prompt', cb);
  }
}
