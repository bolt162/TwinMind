/**
 * AudioProcessLink — the testable abstraction over the MessagePort to
 * `audio-process`.
 *
 * Architecture: §4 (typed IPC between main and the utility process).
 *
 * Tests inject a fake link (just a pair of event emitters) so the orchestrator
 * can be driven without spawning a real utility process. Production wires the
 * link to Electron's `MessageChannelMain` ports in `composition.ts`.
 */

import type { AudioToMain, MainToAudio } from '@audio-process/protocol';

export type AudioFromHandler = (msg: AudioToMain) => void;

export interface AudioProcessLink {
  /** Send a control message to audio-process. PCM never goes this direction. */
  send(msg: MainToAudio): void;
  /**
   * Subscribe to messages coming back from audio-process. Returns the
   * unsubscribe callback. Multiple subscribers are supported (e.g.,
   * ChunkWriter for pcm_frame, orchestrator for chunk_closed).
   */
  on(handler: AudioFromHandler): () => void;
}

/**
 * In-memory link for tests. Both sides own this; main calls `send()` to push
 * MainToAudio messages, and the test (acting as audio-process) calls
 * `deliverFromAudio()` to push AudioToMain messages back.
 */
export class InMemoryAudioLink implements AudioProcessLink {
  private readonly mainListeners = new Set<AudioFromHandler>();
  private readonly outboundSpy: MainToAudio[] = [];
  private readonly outboundListeners = new Set<(msg: MainToAudio) => void>();

  /** Push a MainToAudio message; capture for assertions + forward to spies. */
  send(msg: MainToAudio): void {
    this.outboundSpy.push(msg);
    for (const cb of this.outboundListeners) cb(msg);
  }

  /** Register an AudioToMain handler (orchestrator + ChunkWriter call this). */
  on(handler: AudioFromHandler): () => void {
    this.mainListeners.add(handler);
    return () => this.mainListeners.delete(handler);
  }

  // ─── Test-side helpers ──────────────────────────────────────────────────

  /** Snapshot of every MainToAudio message sent so far. */
  get outbound(): readonly MainToAudio[] {
    return this.outboundSpy;
  }

  /** Subscribe to MainToAudio sends (e.g., to simulate audio-process behavior). */
  onMainToAudio(cb: (msg: MainToAudio) => void): () => void {
    this.outboundListeners.add(cb);
    return () => this.outboundListeners.delete(cb);
  }

  /** Deliver an AudioToMain message as if from audio-process. */
  deliverFromAudio(msg: AudioToMain): void {
    for (const cb of this.mainListeners) cb(msg);
  }
}
