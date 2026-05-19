/**
 * IMicCapture / ISystemAudioCapture — capture-source contracts.
 *
 * Architecture: §7.1 (mic), §7.2 (system audio), §6.2 (per-platform impls).
 *
 * Both shapes are identical event emitters — that's the architectural
 * symmetry the V2 redesign chases (V1 had mic in renderer + system in main).
 *
 * Sources emit 16 kHz mono int16 PCM in `Buffer` form. Sample-rate conversion
 * (e.g., 8 kHz Bluetooth) happens INSIDE the impl, on the audio thread; this
 * interface never sees off-rate data.
 *
 * Errors are emitted, not thrown — capture lifecycles are independent of the
 * promise chain that started them, and a thrown error after start() would
 * have to escape an event-loop tick that nobody is awaiting.
 */

export interface CaptureStartOptions {
  /** Always 16 000 in V2. The setting exists for future flexibility. */
  readonly sampleRate: number;
  /** Always 1 (mono). Stereo is out of scope for V2. */
  readonly channels: 1;
  /** Optional preference; impls fall back to system default. */
  readonly deviceId?: string;
}

export interface DeviceChangeInfo {
  /** Human-readable hint for telemetry. May be null when the OS doesn't expose it. */
  readonly label: string | null;
}

/**
 * Listener registry. We hand-roll a tiny one rather than depending on
 * Node's `EventEmitter`, which gives us typed events without an `any` shim.
 *
 *   - `deviceChange` — informational notification (label hint, no rebind
 *     commitment). For telemetry / UI hints.
 *   - `rebound` — emitted by the impl after it successfully re-binds to a
 *     new device on its own (e.g., the AUHAL impl detecting a system-default
 *     change in auto-detect mode). AudioGraph forwards as `mic_rebound`
 *     so the orchestrator marks `device_boundary=true` on the next chunk.
 */
export interface CaptureEvents {
  pcm: (buf: Buffer, capturedAtMonoNs: bigint) => void;
  deviceChange: (info: DeviceChangeInfo) => void;
  rebound: () => void;
  error: (err: Error) => void;
}

export interface ICapture {
  /** Begin capture. Resolves once the first sample is plausibly imminent. */
  start(opts: CaptureStartOptions): Promise<void>;

  /** Stop capture. Resolves once no more 'pcm' events will fire. */
  stop(): Promise<void>;

  /**
   * Mid-session device hot-swap. Empty string / null = follow system
   * default. Optional on the interface so mock impls can omit it; real
   * impls (native AUHAL) implement it. Emits 'rebound' on success.
   */
  setDevice?(deviceId: string | null): void;

  /** Type-safe `on`; returns an unsubscribe fn. */
  on<E extends keyof CaptureEvents>(event: E, listener: CaptureEvents[E]): () => void;
}

/** Marker types so call sites can read intent without a comment. */
export type IMicCapture = ICapture;
export type ISystemAudioCapture = ICapture;
