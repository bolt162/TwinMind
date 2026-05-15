/**
 * IpcBridgeMain — typed request/push dispatcher for the main process.
 *
 * Architecture: §4 (narrow IPC), §12.7 (Zod validation on both ends).
 *
 * Two surfaces:
 *  - `handle(channel, fn)`: register an async handler for a renderer-initiated
 *    request. Input is parsed through the channel's input schema; the handler
 *    return is parsed through the output schema. Failures throw
 *    `IpcValidationError` so the renderer sees a typed rejection.
 *  - `broadcast(sender, channel, payload)`: validate then send a push event to
 *    a renderer `webContents`. We validate outbound too so a buggy main doesn't
 *    send malformed data that renderer code would have to defensively handle.
 *
 * Electron's `ipcMain` and `webContents` are passed in via structural
 * interfaces so tests can inject fakes (no Electron dependency in this file).
 */

import {
  IpcValidationError,
  PushSchemas,
  RequestSchemas,
  type PushChannelName,
  type RequestChannelName,
} from './validators';
import type { PushPayloads, RequestPayloads } from './channels';
import { type Logger, noopLogger } from '@core/observability/Logger';

/** Structural subset of Electron's `IpcMain` we depend on; lets tests inject fakes. */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown,
  ): void;
  removeHandler(channel: string): void;
}

/** Structural subset of `WebContents` we need for `broadcast`. */
export interface WebContentsLike {
  send(channel: string, payload: unknown): void;
  isDestroyed?(): boolean;
}

/**
 * Optional metadata threaded through to the handler so it can identify the
 * calling renderer (needed for capture-mode IPCs that bind to a specific
 * WebContents). Most handlers ignore this.
 */
export interface RequestContext {
  readonly sender: WebContentsLike;
}

type RequestHandler<C extends RequestChannelName> = (
  input: RequestPayloads[C]['input'],
  ctx?: RequestContext,
) => Promise<RequestPayloads[C]['output']> | RequestPayloads[C]['output'];

export class IpcBridgeMain {
  private readonly registered = new Set<string>();

  /** Construct over an `ipcMain`-shaped object and an optional logger. */
  constructor(private readonly ipc: IpcMainLike, private readonly logger: Logger = noopLogger) {}

  /**
   * Register a handler for a request channel. Input and output are validated
   * against the schemas in `validators.ts`. Handler errors propagate to the
   * renderer as rejections; validation errors throw `IpcValidationError`.
   */
  handle<C extends RequestChannelName>(channel: C, fn: RequestHandler<C>): void {
    if (this.registered.has(channel)) {
      throw new Error(`IpcBridgeMain: channel '${channel}' already registered`);
    }
    const schemas = RequestSchemas[channel];
    this.ipc.handle(channel, async (event, raw) => {
      const parsedIn = schemas.input.safeParse(raw);
      if (!parsedIn.success) {
        this.logger.warn('ipc input rejected', { channel, issues: parsedIn.error.issues });
        throw new IpcValidationError(channel, parsedIn.error.issues);
      }
      // Electron `IpcMainInvokeEvent` carries `sender: WebContents`; the
      // tests' IpcMainLike fake passes plain objects, so we sniff defensively.
      const sender = (event as { sender?: WebContentsLike } | null)?.sender;
      const ctx: RequestContext | undefined = sender ? { sender } : undefined;
      const result = await fn(parsedIn.data as RequestPayloads[C]['input'], ctx);
      const parsedOut = schemas.output.safeParse(result);
      if (!parsedOut.success) {
        // Outbound validation failure is a developer bug — the handler returned
        // a shape that contradicts the contract. Throw so the renderer rejects
        // and the developer sees it in logs; do not silently coerce.
        this.logger.error('ipc output rejected', { channel, issues: parsedOut.error.issues });
        throw new IpcValidationError(channel, parsedOut.error.issues);
      }
      return parsedOut.data;
    });
    this.registered.add(channel);
  }

  /** Tear down a single handler; useful in tests + at app quit. */
  unregister(channel: RequestChannelName): void {
    if (this.registered.delete(channel)) {
      this.ipc.removeHandler(channel);
    }
  }

  /** Tear down every registered handler. */
  unregisterAll(): void {
    for (const ch of [...this.registered]) {
      this.ipc.removeHandler(ch);
    }
    this.registered.clear();
  }

  /**
   * Validate and send a push event to one renderer. Silently skips if the
   * target webContents is destroyed (closed window during shutdown).
   */
  broadcast<C extends PushChannelName>(
    sender: WebContentsLike,
    channel: C,
    payload: PushPayloads[C],
  ): void {
    if (sender.isDestroyed?.()) return;
    const parsed = PushSchemas[channel].safeParse(payload);
    if (!parsed.success) {
      // Outbound shape bug; do not ship malformed events. Throwing here means
      // the caller's stack frame is in the log, which is what we want.
      throw new IpcValidationError(channel, parsed.error.issues);
    }
    sender.send(channel, parsed.data);
  }
}
