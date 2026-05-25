import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsrError } from '@core/asr/AsrError';
import { TwinMindAsrClient } from '@core/asr/TwinMindAsrClient';
import type { TranscribeRequest } from '@core/asr/IAsrClient';

function makeReq(audioPath: string): TranscribeRequest {
  return {
    audioPath,
    sessionId: 'session-abc',
    mode: 'meeting',
    source: 'mixed',
    startOffsetMs: 0,
    endOffsetMs: 30_000,
    overlapPrefixMs: 0,
    chunkWallClockStartMs: 1_700_000_000_000,
    chunkWallClockEndMs: 1_700_000_030_000,
  };
}

interface QueuedResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function buildClient(responses: QueuedResponse[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined; auth?: string | null }> = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    calls.push({ url, init, auth: headers.get('authorization') });
    const r = responses.shift();
    if (!r) throw new Error('no queued response');
    const body =
      typeof r.body === 'string'
        ? r.body
        : r.body === undefined
          ? ''
          : JSON.stringify(r.body);
    return new Response(body, { status: r.status, headers: r.headers });
  };

  let nextAccessToken = 'TOK_1';
  let refreshCount = 0;
  const auth = {
    getAccessToken: async () => nextAccessToken,
    refreshAccessToken: async () => {
      refreshCount++;
      nextAccessToken = `TOK_${refreshCount + 1}`;
      return nextAccessToken;
    },
  };

  const client = new TwinMindAsrClient({
    config: {
      transcribeUrl: 'https://api.example/api/v2/transcribe',
      vercelProtectionBypass: 'bypass',
      dictationModel: 'twinmind-fast-3',
      meetingModel: 'twinmind-pro',
    },
    auth,
    fetchImpl,
  });

  return { client, calls, getRefreshCount: () => refreshCount };
}

describe('TwinMindAsrClient', () => {
  let dir: string;
  let audioPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinmind-asr-'));
    audioPath = path.join(dir, 'chunk.webm');
    fs.writeFileSync(audioPath, Buffer.from([0, 1, 2, 3, 4]));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('happy path: returns a TranscriptSegment with the response text', async () => {
    const { client, calls } = buildClient([
      {
        status: 200,
        body: { transcript: 'hello world', language: 'en' },
      },
    ]);
    const seg = await client.transcribe(makeReq(audioPath));
    expect(seg.text).toBe('hello world');
    expect(seg.language).toBe('en');
    expect(seg.provider).toBe('twinmind');
    // Falls back to the requested model when the response doesn't echo one.
    expect(seg.model).toBe('twinmind-pro');
    // Bearer token forwarded.
    expect(calls[0]?.auth).toBe('Bearer TOK_1');
  });

  it('sends the configured dictation model on dictation requests', async () => {
    const { client, calls } = buildClient([{ status: 200, body: { transcript: '' } }]);
    const req = { ...makeReq(audioPath), mode: 'dictation' as const, source: 'mic' as const };
    await client.transcribe(req);
    const body = calls[0]?.init?.body as FormData;
    expect(body.get('model')).toBe('twinmind-fast-3');
  });

  it('sends the meeting model on mixed/meeting requests', async () => {
    const { client, calls } = buildClient([{ status: 200, body: { transcript: '' } }]);
    await client.transcribe(makeReq(audioPath));
    const body = calls[0]?.init?.body as FormData;
    expect(body.get('model')).toBe('twinmind-pro');
  });

  it('attaches the dictation cleanup prompt on every dictation request', async () => {
    const { client, calls } = buildClient([{ status: 200, body: { transcript: '' } }]);
    const req = { ...makeReq(audioPath), mode: 'dictation' as const, source: 'mic' as const };
    await client.transcribe(req);
    const body = calls[0]?.init?.body as FormData;
    const prompt = body.get('prompt');
    expect(typeof prompt).toBe('string');
    // Tag the test by a stable phrase the cleanup instruction starts with.
    // Full text is a long multi-paragraph instruction; substring match keeps
    // the test resilient to whitespace tweaks.
    expect(String(prompt)).toContain('Rewrite this voice dictation');
  });

  it('does not attach a dictation-cleanup prompt on meeting requests', async () => {
    const { client, calls } = buildClient([{ status: 200, body: { transcript: '' } }]);
    // Meeting request with no contextHint — prompt must be absent.
    await client.transcribe(makeReq(audioPath));
    const body = calls[0]?.init?.body as FormData;
    expect(body.get('prompt')).toBeNull();
  });

  it('prefers the response-reported modelVersion over the requested model', async () => {
    const { client } = buildClient([
      { status: 200, body: { transcript: 'x', modelVersion: 'twinmind-pro-v2.1' } },
    ]);
    const seg = await client.transcribe(makeReq(audioPath));
    expect(seg.model).toBe('twinmind-pro-v2.1');
  });

  it('accepts `text` as an alternate field name', async () => {
    const { client } = buildClient([{ status: 200, body: { text: 'fallback' } }]);
    const seg = await client.transcribe(makeReq(audioPath));
    expect(seg.text).toBe('fallback');
  });

  it('maps word timings to session-absolute ms', async () => {
    const { client } = buildClient([
      {
        status: 200,
        body: {
          transcript: 'hi there',
          words: [
            { word: 'hi', start: 0.1, end: 0.4 },
            { word: 'there', start: 0.5, end: 0.9 },
          ],
        },
      },
    ]);
    const req = { ...makeReq(audioPath), startOffsetMs: 60_000 };
    const seg = await client.transcribe(req);
    expect(seg.words).toEqual([
      { word: 'hi', startMs: 60_100, endMs: 60_400 },
      { word: 'there', startMs: 60_500, endMs: 60_900 },
    ]);
  });

  it('on 401, refreshes once and retries; success on the retry', async () => {
    const { client, calls, getRefreshCount } = buildClient([
      { status: 401, body: { error: 'expired' } },
      { status: 200, body: { transcript: 'OK after refresh' } },
    ]);
    const seg = await client.transcribe(makeReq(audioPath));
    expect(seg.text).toBe('OK after refresh');
    expect(getRefreshCount()).toBe(1);
    expect(calls[0]?.auth).toBe('Bearer TOK_1');
    expect(calls[1]?.auth).toBe('Bearer TOK_2');
  });

  it('on 401 twice, throws AsrError(auth) (no further retries here)', async () => {
    const { client } = buildClient([
      { status: 401, body: { error: 'expired' } },
      { status: 401, body: { error: 'still bad' } },
    ]);
    await expect(client.transcribe(makeReq(audioPath))).rejects.toMatchObject({
      name: 'AsrError',
      kind: 'auth',
    });
  });

  it('maps 5xx -> AsrError(server_5xx)', async () => {
    const { client } = buildClient([{ status: 503, body: 'oops' }]);
    try {
      await client.transcribe(makeReq(audioPath));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AsrError);
      expect((err as AsrError).kind).toBe('server_5xx');
    }
  });

  it('honors Retry-After on 429 (seconds form)', async () => {
    const { client } = buildClient([
      {
        status: 429,
        body: 'slow down',
        headers: { 'retry-after': '7' },
      },
    ]);
    try {
      await client.transcribe(makeReq(audioPath));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AsrError);
      const e = err as AsrError;
      expect(e.kind).toBe('rate_limit');
      expect(e.retryAfterMs).toBe(7_000);
    }
  });

  it('maps 413 -> AsrError(bad_audio)', async () => {
    const { client } = buildClient([{ status: 413, body: 'too big' }]);
    try {
      await client.transcribe(makeReq(audioPath));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as AsrError).kind).toBe('bad_audio');
    }
  });

  it('maps an abort to AsrError(timeout)', async () => {
    const client = new TwinMindAsrClient({
      config: {
        transcribeUrl: 'https://api.example/api/v2/transcribe',
        vercelProtectionBypass: 'bypass',
      },
      auth: {
        getAccessToken: async () => 'TOK',
        refreshAccessToken: async () => 'TOK',
      },
      timeoutMs: 5,
      fetchImpl: async (_url, init) => {
        // Honor the abort signal — wait for it to fire then reject.
        return new Promise((_resolve, reject) => {
          const sig = init?.signal as AbortSignal | undefined;
          if (sig?.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
            return;
          }
          sig?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      },
    });
    try {
      await client.transcribe(makeReq(audioPath));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as AsrError).kind).toBe('timeout');
    }
  });

  it('maps a fetch throw to AsrError(network)', async () => {
    const client = new TwinMindAsrClient({
      config: {
        transcribeUrl: 'https://api.example/api/v2/transcribe',
        vercelProtectionBypass: 'bypass',
      },
      auth: {
        getAccessToken: async () => 'TOK',
        refreshAccessToken: async () => 'TOK',
      },
      fetchImpl: async () => {
        const err = new Error('connect ECONNREFUSED');
        err.name = 'FetchError';
        throw err;
      },
    });
    try {
      await client.transcribe(makeReq(audioPath));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as AsrError).kind).toBe('network');
    }
  });

  it('throws AsrError(auth) when getAccessToken rejects', async () => {
    const client = new TwinMindAsrClient({
      config: {
        transcribeUrl: 'https://api.example/api/v2/transcribe',
        vercelProtectionBypass: 'bypass',
      },
      auth: {
        getAccessToken: async () => {
          throw new Error('not signed in');
        },
        refreshAccessToken: async () => 'TOK',
      },
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    try {
      await client.transcribe(makeReq(audioPath));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as AsrError).kind).toBe('auth');
    }
  });
});
