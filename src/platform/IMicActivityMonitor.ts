/**
 * IMicActivityMonitor — fires when *any* process opens the mic.
 *
 * Architecture: §8.1 — primitive for the meeting-auto-detect UX. macOS impl
 * wraps `kAudioDevicePropertyDeviceIsRunningSomewhere`; Windows impl will
 * wrap `IAudioSessionManager2`.
 *
 * No TCC prompt required (it's a device-state read, not a content read).
 */

export interface IMicActivityMonitor {
  start(): void;
  stop(): void;
  /** Fired when another process opens the default-input mic. */
  onMicStarted(cb: () => void): () => void;
  /** Fired when the same process releases the default-input mic. */
  onMicStopped(cb: () => void): () => void;
}
