import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GroqAsrClient } from '@core/asr/GroqAsrClient';
import { AsrError } from '@core/asr/AsrError';
import type { TranscribeRequest } from '@core/asr/IAsrClient';

/** Construct a TranscribeRequest pointing at a small temp WAV. */
function makeReq(audioPath: string): TranscribeRequest {
  return {
    audioPath,
    mode: 'meeting',
    source: 'mixed',
    startOffsetMs: 0,
    endOffsetMs: 30_000,
    overlapPrefixMs: 0,
    language: 'en',
  };
}

/** Build a minimal mock fetch that returns the given Response. */
function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fn = async (_url: string, _init: unknown) => {
    void _url;
    void _init;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers,
    });
  };
  return fn as unknown as typeof globalThis.fetch;
}

describe('GroqAsrClient', () => {
  let dir: string;
  let audioPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'groq-test-'));
    audioPath = path.join(dir, 'test.wav');
    // Any non-empty payload — the body is consumed by FormData but never parsed in tests.
    fs.writeFileSync(audioPath, Buffer.alloc(1024, 0x55));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns a TranscriptSegment on 200 verbose_json', async () => {
    const client = new GroqAsrClient({
      config: {},
      getApiKey: () => 'gsk_test_key',
      fetchImpl: mockFetch(200, {
        text: 'hello world',
        language: 'english',
        words: [
          { word: 'hello', start: 0.0, end: 0.5 },
          { word: 'world', start: 0.5, end: 1.0 },
        ],
      }),
    });
    const seg = await client.transcribe(makeReq(audioPath));
    expect(seg.text).toBe('hello world');
    expect(seg.provider).toBe('groq');
    expect(seg.words?.[0]).toEqual({ word: 'hello', startMs: 0, endMs: 500 });
    expect(seg.words?.[1]).toEqual({ word: 'world', startMs: 500, endMs: 1000 });
    expect(seg.language).toBe('english');
  });

  it('throws AsrError("auth") when no API key is configured', async () => {
    const client = new GroqAsrClient({
      config: {},
      getApiKey: () => null,
      fetchImpl: mockFetch(200, {}),
    });
    await expect(client.transcribe(makeReq(audioPath))).rejects.toMatchObject({
      kind: 'auth',
    });
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [408, 'timeout'],
    [413, 'bad_audio'],
    [415, 'bad_audio'],
    [429, 'rate_limit'],
    [500, 'server_5xx'],
    [503, 'server_5xx'],
    [400, 'client_4xx'],
    [422, 'client_4xx'],
  ] as const)('maps HTTP %i → AsrError.%s', async (status, kind) => {
    const client = new GroqAsrClient({
      config: {},
      getApiKey: () => 'gsk',
      fetchImpl: mockFetch(status, '{}'),
    });
    try {
      await client.transcribe(makeReq(audioPath));
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AsrError);
      expect((e as AsrError).kind).toBe(kind);
    }
  });

  it('parses delta-seconds Retry-After into retryAfterMs', async () => {
    const client = new GroqAsrClient({
      config: {},
      getApiKey: () => 'gsk',
      fetchImpl: mockFetch(429, '{}', { 'retry-after': '7' }),
    });
    try {
      await client.transcribe(makeReq(audioPath));
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as AsrError).retryAfterMs).toBe(7_000);
    }
  });

  it('classifies a thrown fetch error as network', async () => {
    const failingFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const client = new GroqAsrClient({
      config: {},
      getApiKey: () => 'gsk',
      fetchImpl: failingFetch,
    });
    try {
      await client.transcribe(makeReq(audioPath));
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as AsrError).kind).toBe('network');
    }
  });

  it('classifies an AbortError as timeout', async () => {
    const abortingFetch = (async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as unknown as typeof globalThis.fetch;
    const client = new GroqAsrClient({
      config: {},
      getApiKey: () => 'gsk',
      fetchImpl: abortingFetch,
    });
    try {
      await client.transcribe(makeReq(audioPath));
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as AsrError).kind).toBe('timeout');
    }
  });
});
