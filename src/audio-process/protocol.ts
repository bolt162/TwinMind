/**
 * Message protocol between main and `audio-process` (utility process).
 *
 * Architecture: §4 (utility process audio path), §7.3 (capture topology).
 *
 * Transport: a single MessagePort opened via `utilityProcess.fork()` +
 * `MessageChannel`. The audio-process is started by main; main holds one port,
 * audio-process holds the other. All messages are discriminated unions tagged
 * by `type` so a tiny switch fully handles them.
 *
 * Important: PCM frames travel as `Buffer` instances. Node's structured-clone
 * for Buffer is zero-copy when the underlying ArrayBuffer is transferred —
 * the `transferList` argument to `port.postMessage` is what makes it cheap.
 * The audio thread should pass the underlying ArrayBuffer in the transfer
 * list so we never memcpy at the boundary.
 */

// ─── Main → audio-process (control) ─────────────────────────────────────────

export type MainToAudio =
  | StartSessionMsg
  | StopSessionMsg
  | OpenChunkMsg
  | CloseChunkMsg
  | SetMicDeviceMsg
  | ShutdownMsg;

/** Begin capturing for a fresh session. */
export interface StartSessionMsg {
  readonly type: 'start_session';
  readonly sessionId: string;
  readonly mode: 'dictation' | 'meeting';
  /** True iff system-audio capture should be enabled (only meaningful in `meeting`). */
  readonly enableSystemAudio: boolean;
  /** 16 000 for V2; configurable for future. */
  readonly sampleRate: number;
  /**
   * Optional CoreAudio device UID. When set, the native AUHAL mic capture
   * pins to this device; when null/undefined, it follows the system default
   * input (and live-rebinds on `kAudioHardwarePropertyDefaultInputDevice`
   * changes). Used by the Settings "Input device" picker.
   */
  readonly micDeviceId?: string;
  /**
   * Seed value for the audio-process's `samplesEmitted` counter. Used by
   * `resumeFromDeviceLoss` so the resumed session's audio-clock continues
   * from where the previous session left off (the last chunk's `end_ms`)
   * instead of resetting to 0. Without this the HUD timer would jump back
   * to 0:00 on resume and the new chunks would be stamped from wall-clock
   * elapsed-since-session-start, producing a confusing visible gap.
   * Omit/0 for fresh sessions.
   */
  readonly audioClockStartMs?: number;
}

/**
 * Mid-session mic device switch. Audio-process forwards to native's
 * `setDevice`; emits a `mic_rebound` on success. Triggered by main when the
 * user changes their device pick in Settings while a recording is in
 * flight (without this, the change would only take effect on next session).
 */
export interface SetMicDeviceMsg {
  readonly type: 'set_mic_device';
  /** UID to pin, or null/undefined to switch back to auto-detect. */
  readonly micDeviceId?: string;
}

/** Stop capture; finalize anything pending; do not emit further pcm_frames. */
export interface StopSessionMsg {
  readonly type: 'stop_session';
}

/**
 * Open a new chunk slot. The audio-process will:
 *  - mark `start_ms` as the next pcm frame's session offset
 *  - emit pcm_frames with `chunkId` until close
 *  - on close, send `chunk_closed` with the running sumSquares + sample count
 */
export interface OpenChunkMsg {
  readonly type: 'open_chunk';
  readonly chunkId: string;
  /** ms offset from session start where this chunk begins. */
  readonly startMs: number;
  /**
   * If non-zero, the audio-process should prepend this many ms of previously
   * emitted PCM to the new chunk (the 2 s overlap of meeting mode).
   */
  readonly overlapPrefixMs: number;
}

/** Close the active chunk, flush its tail, emit `chunk_closed`. */
export interface CloseChunkMsg {
  readonly type: 'close_chunk';
  readonly chunkId: string;
  /** ms offset from session start where this chunk ends. */
  readonly endMs: number;
}

export interface ShutdownMsg {
  readonly type: 'shutdown';
}

// ─── audio-process → main (data + events) ──────────────────────────────────

export type AudioToMain =
  | PcmFrameMsg
  | ChunkClosedMsg
  | AmplitudeSampleMsg
  | DeviceChangeMsg
  | MicReboundMsg
  | CaptureErrorMsg
  | RotationDueMsg
  | ReadyMsg;

/** Emitted on every audio-thread tick (~100 ms of PCM). */
export interface PcmFrameMsg {
  readonly type: 'pcm_frame';
  readonly chunkId: string;
  /** int16 mono PCM. Receive side wraps in `Buffer.from(arrayBuffer)`. */
  readonly pcm: ArrayBuffer;
  /** Monotonic ns from the audio-process clock at frame capture. */
  readonly capturedAtMonoNs: string;
  /** ms offset from session start at the START of this frame. */
  readonly frameStartMs: number;
}

/** Final stats for a closed chunk; main uses these to write the WAV header + VAD. */
export interface ChunkClosedMsg {
  readonly type: 'chunk_closed';
  readonly chunkId: string;
  /** Total bytes written for this chunk (post-mix, before any WAV header). */
  readonly bytesWritten: number;
  /** Σ s² across the whole chunk; feeds VadGate.evaluate. */
  readonly sumSquares: number;
  readonly sampleCount: number;
}

/**
 * One sample of normalized input level for the live HUD waveform. Emitted at
 * roughly the PCM-frame rate (~10 Hz). Decoupled from chunk_closed because
 * chunks close every 30 s — way too slow for a visible meter.
 */
export interface AmplitudeSampleMsg {
  readonly type: 'amplitude_sample';
  /** RMS of the most recent frame, normalized to [0, 1]. */
  readonly value: number;
  /**
   * Cumulative audio-clock since session start, in milliseconds — `samples
   * processed / sample_rate * 1000`. The HUD uses this as the authoritative
   * elapsed timer instead of wall-clock, so a Bluetooth gap (or any capture
   * stall) freezes the timer alongside the waveform. Strictly monotonic
   * within a session.
   */
  readonly audioClockMs: number;
}

/** Bluetooth route change, default-device flip, etc. (§7.7) */
export interface DeviceChangeMsg {
  readonly type: 'device_change';
  readonly kind: 'mic' | 'system';
  /** Human-readable hint for telemetry ("AirPods Pro", "built-in"). */
  readonly label: string | null;
}

/**
 * Emitted after AudioGraph successfully rebinds the mic capture to a new
 * device (in response to device_change). The orchestrator uses this to
 * mark the next chunk with `device_boundary=true` and to surface a brief
 * notification to the user.
 */
export interface MicReboundMsg {
  readonly type: 'mic_rebound';
}

/**
 * Audio-process-side signal that the current chunk has accumulated the
 * architectural target of *new* audio (excluding any overlap prepend). Main
 * responds by sending the standard `close_chunk` + `open_chunk` pair. This
 * replaces the old wall-clock `setInterval` rotation in the orchestrator —
 * with this, chunks are always exactly 30 s of new audio long, regardless
 * of scheduler jitter or capture stalls.
 */
export interface RotationDueMsg {
  readonly type: 'rotation_due';
}

/** Non-recoverable error from one of the capture sources. */
export interface CaptureErrorMsg {
  readonly type: 'capture_error';
  readonly source: 'mic' | 'system';
  readonly message: string;
}

/** Sent once after entry.ts has subscribed to its MessagePort. */
export interface ReadyMsg {
  readonly type: 'ready';
}
