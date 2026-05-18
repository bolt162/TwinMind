import { describe, it, expect, beforeEach } from 'vitest';
import { REQUEST, PUSH } from '@ipc/channels';
import { IpcBridgeMain, type IpcMainLike, type WebContentsLike } from '@ipc/bridge.main';
import { IpcValidationError } from '@ipc/validators';

/** Tiny fake ipcMain that records registered handlers and lets the test invoke them. */
function fakeIpc(): IpcMainLike & {
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
  registered: Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown>;
} {
  const registered = new Map<
    string,
    (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown
  >();
  return {
    handle(channel, listener) {
      registered.set(channel, listener);
    },
    removeHandler(channel) {
      registered.delete(channel);
    },
    registered,
    async invoke(channel, payload) {
      const handler = registered.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      return handler({}, payload);
    },
  };
}

function fakeWebContents(): WebContentsLike & { sent: Array<{ channel: string; payload: unknown }> } {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    sent,
    send(channel, payload) {
      sent.push({ channel, payload });
    },
    isDestroyed: () => false,
  };
}

describe('IpcBridgeMain.handle', () => {
  let ipc: ReturnType<typeof fakeIpc>;
  let bridge: IpcBridgeMain;

  beforeEach(() => {
    ipc = fakeIpc();
    bridge = new IpcBridgeMain(ipc);
  });

  it('validates and forwards a well-formed request', async () => {
    bridge.handle(REQUEST.REC_START_MEETING, async (input) => ({ sessionId: `s_${input.title ?? '_'}` }));
    const out = await ipc.invoke(REQUEST.REC_START_MEETING, { title: 'standup' });
    expect(out).toEqual({ sessionId: 's_standup' });
  });

  it('throws IpcValidationError on malformed input (renderer-side bug)', async () => {
    bridge.handle(REQUEST.REC_STOP_MEETING, async () => ({}));
    await expect(ipc.invoke(REQUEST.REC_STOP_MEETING, {})).rejects.toBeInstanceOf(
      IpcValidationError,
    );
  });

  it('throws IpcValidationError when a handler returns the wrong output shape', async () => {
    // Force a handler to violate the output contract — should surface as a bridge error.
    bridge.handle(REQUEST.REC_START_MEETING, async () => ({}) as unknown as { sessionId: string });
    await expect(
      ipc.invoke(REQUEST.REC_START_MEETING, { title: 't' }),
    ).rejects.toBeInstanceOf(IpcValidationError);
  });

  it('refuses double registration of the same channel', () => {
    bridge.handle(REQUEST.REC_START_DICTATION, async () => ({}));
    expect(() => bridge.handle(REQUEST.REC_START_DICTATION, async () => ({}))).toThrow(/already/);
  });

  it('unregisterAll removes every registered handler', () => {
    bridge.handle(REQUEST.REC_START_DICTATION, async () => ({}));
    bridge.handle(REQUEST.REC_STOP_DICTATION, async () => ({}));
    expect(ipc.registered.size).toBe(2);
    bridge.unregisterAll();
    expect(ipc.registered.size).toBe(0);
  });
});

describe('IpcBridgeMain.broadcast', () => {
  let bridge: IpcBridgeMain;

  beforeEach(() => {
    bridge = new IpcBridgeMain(fakeIpc());
  });

  it('validates outbound and sends', () => {
    const wc = fakeWebContents();
    bridge.broadcast(wc, PUSH.QUEUE_STATUS, { pending: 1, uploading: 1, failedPermanent: 0 });
    expect(wc.sent).toHaveLength(1);
    expect(wc.sent[0]).toMatchObject({
      channel: 'queue_status_changed',
      payload: { pending: 1, uploading: 1, failedPermanent: 0 },
    });
  });

  it('throws IpcValidationError on a malformed broadcast (caller bug)', () => {
    const wc = fakeWebContents();
    // pending must be a non-negative integer; -1 violates the schema.
    expect(() =>
      bridge.broadcast(wc, PUSH.QUEUE_STATUS, {
        pending: -1,
        uploading: 0,
        failedPermanent: 0,
      } as unknown as { pending: number; uploading: number; failedPermanent: number }),
    ).toThrow(IpcValidationError);
  });

  it('skips destroyed webContents silently (no throw)', () => {
    const wc = { ...fakeWebContents(), isDestroyed: () => true };
    expect(() =>
      bridge.broadcast(wc, PUSH.QUEUE_STATUS, { pending: 0, uploading: 0, failedPermanent: 0 }),
    ).not.toThrow();
  });
});
