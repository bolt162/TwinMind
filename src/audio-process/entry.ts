/**
 * audio-process entry — the utilityProcess target.
 *
 * Architecture: §4 (Electron utilityProcess hosts the audio path).
 *
 * Lifecycle:
 *   1. Main spawns us via `utilityProcess.fork(__dirname + '/dist/audio-process/entry.js')`.
 *   2. Main posts a `MessagePort` over `process.parentPort.postMessage`.
 *   3. We receive the port and dispatch `MainToAudio` messages onto an `AudioGraph`.
 *   4. We answer with `AudioToMain` messages; PCM frames travel zero-copy via transferList.
 *
 * Capture backend selection: `TWINMIND_MIC_BACKEND=mock` substitutes the mock
 * impl, which is essential for tests that run without real audio hardware.
 * The real native backend lives in `native/coreaudio-darwin` and is loaded
 * lazily so test-mode runs don't pull in the .node binary.
 */

import { AudioGraph } from './AudioGraph';
import type { MainToAudio, AudioToMain } from './protocol';
import { MockMicCapture } from './MockMicCapture';
import type { ICapture, IMicCapture, ISystemAudioCapture } from './IMicCapture';
import { resolveAudioteeBinaryPath } from '@platform/audioteeBinaryPath';

/** Build a mic-capture impl per environment. Mock by default in tests. */
function selectMicCapture(): IMicCapture {
  const backend = process.env.TWINMIND_MIC_BACKEND ?? 'native';
  if (backend === 'mock') {
    process.stderr.write('[audio-process] using MOCK silence mic (TWINMIND_MIC_BACKEND=mock)\n');
    return MockMicCapture.silence();
  }
  if (backend === 'mock_sine') {
    process.stderr.write('[audio-process] using MOCK sine mic (TWINMIND_MIC_BACKEND=mock_sine)\n');
    return MockMicCapture.sine();
  }
  // Real impl: dynamically required so the addon isn't loaded in tests.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const native = require('@twinmind/coreaudio-darwin') as {
      micCapture: () => ICapture;
    };
    const cap = native.micCapture();
    process.stderr.write('[audio-process] using NATIVE coreaudio-darwin mic\n');
    return cap;
  } catch (err) {
    // The addon failed to load (ABI mismatch, missing binary, …). Crashing
    // here would silently kill audio-process before main can diagnose it.
    // Fall back to a silent mock + write an obvious stderr line so the user
    // sees what's wrong in the dev terminal.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `\n[audio-process] FATAL: @twinmind/coreaudio-darwin failed to load: ${msg}\n` +
        `[audio-process] Falling back to silent mock — no audio will be captured.\n` +
        `[audio-process] Fix: npm run rebuild:coreaudio:electron\n\n`,
    );
    return MockMicCapture.silence();
  }
}

/** Build a system-audio impl. `audiotee` is the only real backend today. */
function selectSystemAudioCapture(): ISystemAudioCapture | undefined {
  const backend = process.env.TWINMIND_MIC_BACKEND ?? 'native';
  if (backend.startsWith('mock')) return MockMicCapture.silence();
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const audiotee = require('audiotee') as unknown;
    return new AudioTeeAdapter(audiotee);
  } catch (err) {
    // System audio capture is optional — dictation still works without it,
    // and meeting mode just gets mic-only. Log and move on.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[audio-process] audiotee unavailable: ${msg}\n`);
    return undefined;
  }
}

/**
 * AudioTeeAdapter wraps the `audiotee` package into our `ISystemAudioCapture`
 * shape so the graph doesn't know about specific impls. Kept here so the
 * adapter and the lazy require live in one file.
 */
class AudioTeeAdapter implements ICapture {
  private tee: { start(): Promise<void>; stop(): Promise<void>; on: (e: string, cb: (...args: any[]) => void) => void } | null = null;
  private readonly listeners: {
    pcm: Set<any>;
    deviceChange: Set<any>;
    rebound: Set<any>;
    error: Set<any>;
  } = {
    pcm: new Set(),
    deviceChange: new Set(),
    rebound: new Set(),
    error: new Set(),
  };

  /** Construct with the audiotee module (untyped; populated when the dep loads). */
  constructor(private readonly mod: any) {}

  /** Open the tap; audiotee emits 'data' with raw PCM chunks at ~100 ms. */
  async start(opts: { sampleRate: number }): Promise<void> {
    const AudioTee = this.mod.AudioTee ?? this.mod.default ?? this.mod;
    const binaryPath = resolveAudioteeBinaryPath() ?? undefined;
    this.tee = new AudioTee({
      sampleRate: opts.sampleRate,
      chunkDurationMs: 100,
      binaryPath,
    });
    this.tee!.on('data', (chunk: { data: Buffer }) => {
      const nano = process.hrtime.bigint();
      for (const cb of this.listeners.pcm) cb(chunk.data, nano);
    });
    this.tee!.on('error', (e: Error) => {
      for (const cb of this.listeners.error) cb(e);
    });
    await this.tee!.start();
  }

  /** Stop the tap; idempotent. */
  async stop(): Promise<void> {
    await this.tee?.stop().catch(() => {});
    this.tee = null;
  }

  /** Standard type-safe subscribe; returns an unsubscribe. */
  on(event: 'pcm' | 'deviceChange' | 'rebound' | 'error', listener: any): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }
}

/**
 * Bootstrap the process once main sends us the MessagePort. parentPort is
 * defined inside utilityProcess; outside (e.g., tests), entry.ts can be
 * imported without side effects.
 */
function bootstrap(): void {
  // Structural type for the port handed to us by Electron's utilityProcess.
  // Despite being a MessagePort by name, MessagePortMain uses Node's
  // EventEmitter style (`.on('message', cb)`), NOT the DOM `.onmessage`
  // property. Assigning `.onmessage` is silently dropped — that's the bug
  // that caused messages from main → audio-process to be discarded.
  interface PortLike {
    postMessage(msg: unknown, transferList?: unknown[]): void;
    on(event: 'message', cb: (ev: { data: unknown }) => void): void;
    start(): void;
  }
  interface ParentPortLike {
    postMessage(msg: unknown, transferList?: unknown[]): void;
    on(event: string, cb: (msg: { ports?: PortLike[] }) => void): void;
  }

  // `process.parentPort` exists in Electron utility processes. We guard the
  // typeof so this file can also be unit-imported.
  const parentPort: ParentPortLike | undefined =
    (process as unknown as { parentPort?: ParentPortLike }).parentPort;
  if (!parentPort) return;

  let port: PortLike | null = null;
  let graph: AudioGraph | null = null;

  /** Send an AudioToMain message; PCM frames pass their ArrayBuffer in transferList. */
  const send = (msg: AudioToMain, transferList?: unknown[]): void => {
    if (!port) return;
    port.postMessage(msg, transferList ?? []);
  };

  parentPort.on('message', (e) => {
    // First message from main hands us the port; any subsequent messages on
    // parentPort are control signals (shutdown).
    if (e.ports?.length && !port) {
      port = e.ports[0]!;
      const mic = selectMicCapture();
      const sys = selectSystemAudioCapture();
      process.stderr.write(
        `[audio-process] ready · mic=${(mic as { constructor: { name: string } }).constructor.name} · sys=${
          sys ? (sys as { constructor: { name: string } }).constructor.name : 'none'
        }\n`,
      );
      graph = new AudioGraph({ mic, system: sys, send });
      // Serialize message handling. Without this, an `open_chunk` arriving
      // while `start_session` is still awaiting its native setup runs against
      // an uninitialized graph and silently no-ops — then the matching
      // `close_chunk` finds `currentChunkId === null` and never emits
      // `chunk_closed`, leaving main's TranscriptionUx waiting forever.
      // Chaining each dispatch onto the tail of the previous Promise
      // guarantees start → open → close are processed in order, fully.
      let queue: Promise<void> = Promise.resolve();
      port.on('message', (ev) => {
        queue = queue.then(() => dispatch(ev.data as MainToAudio));
      });
      port.start();
      send({ type: 'ready' });
    }
  });

  const dispatch = async (msg: MainToAudio): Promise<void> => {
    if (!graph) return;
    try {
      switch (msg.type) {
        case 'start_session':
          await graph.startSession(msg);
          // Watchdog: if no PCM lands within 2 s, the mic is silently dead.
          // Single-shot per session; fires only on regression.
          setTimeout(() => {
            if (!graph) return;
            const status = graph.diagnosticStatus();
            if (!status.firstMicFrameSeen) {
              process.stderr.write(
                `[audio-process] [WATCHDOG] no mic PCM 2s after start. Engine claims started but no frames arrived.\n`,
              );
            }
          }, 2_000);
          return;
        case 'stop_session':
          await graph.stopSession();
          return;
        case 'open_chunk':
          graph.openChunk(msg);
          return;
        case 'close_chunk':
          graph.closeChunk(msg);
          return;
        case 'shutdown':
          await graph.stopSession();
          return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[audio-process] dispatch(${msg.type}) FAILED: ${message}\n`);
      send({ type: 'capture_error', source: 'mic', message: `dispatch(${msg.type}): ${message}` });
    }
  };
}

bootstrap();
