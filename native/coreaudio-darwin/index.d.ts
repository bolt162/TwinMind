/**
 * @twinmind/coreaudio-darwin — type declarations.
 *
 * The .d.ts mirrors the JS adapter in `index.js`. The native .node binary is
 * not typed directly; this surface is what audio-process consumes.
 */

export interface ICaptureLike {
  start(opts?: unknown): Promise<void>;
  stop(): Promise<void>;
  /** Mid-session device hot-swap; empty string = follow system default. */
  setDevice(deviceId: string): void;
  on(event: 'pcm', cb: (buf: Buffer, capturedAtMonoNs: bigint) => void): () => void;
  on(event: 'deviceChange', cb: (info: { label: string | null }) => void): () => void;
  on(event: 'rebound', cb: () => void): () => void;
  on(event: 'error', cb: (err: Error) => void): () => void;
}

export interface IMicMonitorLike {
  start(): void;
  stop(): void;
  on(event: 'started', cb: () => void): () => void;
  on(event: 'stopped', cb: () => void): () => void;
}

export interface IDeviceChangeMonitorLike {
  start(): void;
  stop(): void;
  on(
    event: 'change',
    cb: (info: {
      label: string | null;
      kind: 'built_in' | 'bluetooth' | 'usb' | 'other';
      noDevice: boolean;
    }) => void,
  ): () => void;
}

export interface InputDeviceInfo {
  /** Stable CoreAudio device UID — pass as `CaptureStartOptions.deviceId`. */
  readonly id: string;
  /** Human-readable name ("MacBook Pro Microphone", "AirPods Pro"). */
  readonly name: string;
  /** True iff this device is currently the system default input. */
  readonly isDefault: boolean;
  /** Transport class read from kAudioDevicePropertyTransportType — used by
   *  the Settings picker to group entries. "other" covers aggregate, virtual,
   *  HDMI, and unknown transports. */
  readonly kind: 'built_in' | 'bluetooth' | 'usb' | 'other';
}

export interface IGlobeKeyLike {
  /** Install the CGEventTap. Returns true on success, false if macOS
   *  Accessibility permission is missing. Idempotent while already running. */
  start(): boolean;
  stop(): void;
  on(event: 'press', cb: () => void): () => void;
  on(event: 'release', cb: () => void): () => void;
  /**
   * Fires when the native event-tap callback has determined the CGEventTap
   * is dead and torn it down. Two causes today:
   *   - macOS revoked Accessibility (kCGEventTapDisabledByUserInput).
   *   - Timeout-re-enable storm or trust missing on re-enable.
   * The manager should mark the tap uninstalled and poll trust before
   * calling start() again.
   */
  on(event: 'tap_lost', cb: () => void): () => void;
}

export declare function micCapture(): ICaptureLike;
export declare function micMonitor(): IMicMonitorLike;
export declare function deviceMonitor(): IDeviceChangeMonitorLike;
export declare function listInputDevices(): InputDeviceInfo[];
export declare function globeKey(): IGlobeKeyLike;

/**
 * Synthesize a Cmd+V keystroke. Returns true if the events were posted
 * (caller should still gate on Accessibility being trusted, since CGEventPost
 * silently drops events for untrusted processes).
 */
export declare function pasteCommandV(): boolean;

export interface IFnUsageTypeLike {
  /**
   * Read NSGlobalDomain.AppleFnUsageType. Returns:
   *   0 = Do Nothing
   *   1 = Show Emoji & Symbols (macOS default)
   *   2 = Change Input Source
   *   3 = Start Dictation
   *   null = key unset (OS treats as 1) or addon missing
   */
  get(): number | null;
  /** Persist and live-reload the value. Returns true on success. */
  set(value: number): boolean;
}
export declare function fnUsageType(): IFnUsageTypeLike;
