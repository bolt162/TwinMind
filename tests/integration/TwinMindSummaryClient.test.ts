import { describe, it, expect } from 'vitest';
import {
  SummaryError,
  TwinMindSummaryClient,
  parseFinalSummaryLine,
} from '@core/summary/TwinMindSummaryClient';

function buildClient(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: RequestInit | undefined; auth: string | null; body: string }> = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const body = (init?.body as string | undefined) ?? '';
    calls.push({ url, init, auth: headers.get('authorization'), body });
    const r = responses.shift();
    if (!r) throw new Error('no queued response');
    const text =
      typeof r.body === 'string' ? r.body : r.body === undefined ? '' : JSON.stringify(r.body);
    return new Response(text, { status: r.status, headers: r.headers });
  };

  let token = 'TOK_1';
  let refreshCount = 0;
  const auth = {
    getAccessToken: async () => token,
    refreshAccessToken: async () => {
      refreshCount++;
      token = `TOK_${refreshCount + 1}`;
      return token;
    },
  };

  const client = new TwinMindSummaryClient({
    config: { summaryUrl: 'https://api.example/api/v2/summary', vercelProtectionBypass: 'bypass' },
    auth,
    fetchImpl,
  });
  return { client, calls, getRefreshCount: () => refreshCount };
}

const REQ = {
  sessionId: 'session-1',
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_060_000,
};

describe('parseFinalSummaryLine', () => {
  it('picks the line with summary_id even if there are progress lines after it', () => {
    const body = [
      '{"event":"start"}',
      '{"progress":50}',
      '{"summary_id":"sum-1","title":"Hi"}',
      '{"trailing":"noise"}',
    ].join('\n');
    expect(parseFinalSummaryLine(body)).toEqual({ summary_id: 'sum-1', title: 'Hi' });
  });

  it('returns the last valid JSON line when none has summary_id', () => {
    const body = '{"event":"start"}\n{"event":"end"}';
    expect(parseFinalSummaryLine(body)).toEqual({ event: 'end' });
  });

  it('returns null when the body has no parseable JSON', () => {
    expect(parseFinalSummaryLine('not json\nstill not json')).toBeNull();
  });

  it('handles a single-line response', () => {
    expect(parseFinalSummaryLine('{"summary_id":"x"}')).toEqual({ summary_id: 'x' });
  });
});

describe('TwinMindSummaryClient — request shape', () => {
  it('omits transcript and sends V1-style metadata', async () => {
    const { client, calls } = buildClient([
      { status: 200, body: { summary_id: 'sum-1' } },
    ]);
    await client.requestSummary(REQ);
    const sent = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(sent).not.toHaveProperty('transcript');
    expect(sent.meetingId).toBe('session-1');
    expect(sent.log_data).toBe(true);
    expect(sent.personalization).toBe('');
    const meta = sent.metadata as Record<string, unknown>;
    expect(meta.deviceType).toBe('twinmind_desktop');
    expect(meta.log_Audio).toBe('false');
    expect(meta.durationMs).toBe(60_000);
    expect(meta.durationSeconds).toBe(60);
  });

  it('sets the bearer token + bypass header', async () => {
    const { client, calls } = buildClient([{ status: 200, body: { summary_id: 'x' } }]);
    await client.requestSummary(REQ);
    expect(calls[0]?.auth).toBe('Bearer TOK_1');
    const headers = new Headers(calls[0]?.init?.headers as HeadersInit | undefined);
    expect(headers.get('x-vercel-protection-bypass')).toBe('bypass');
  });
});

describe('TwinMindSummaryClient — happy path', () => {
  it('parses summaryId + title from the final NDJSON line', async () => {
    const ndjson = [
      '{"event":"start"}',
      '{"progress":50}',
      '{"summary_id":"sum-42","title":"Weekly sync"}',
    ].join('\n');
    const { client } = buildClient([{ status: 200, body: ndjson }]);
    const result = await client.requestSummary(REQ);
    expect(result).toEqual({ summaryId: 'sum-42', title: 'Weekly sync' });
  });
});

describe('TwinMindSummaryClient — auth refresh', () => {
  it('on 401, refreshes once and retries; second call succeeds', async () => {
    const { client, calls, getRefreshCount } = buildClient([
      { status: 401, body: { error: 'expired' } },
      { status: 200, body: { summary_id: 'sum-after' } },
    ]);
    const result = await client.requestSummary(REQ);
    expect(result.summaryId).toBe('sum-after');
    expect(getRefreshCount()).toBe(1);
    expect(calls[0]?.auth).toBe('Bearer TOK_1');
    expect(calls[1]?.auth).toBe('Bearer TOK_2');
  });

  it('on 401 twice, throws SummaryError(auth) — but wait, we map second 401 to client_4xx', async () => {
    // Actually the implementation maps a 401 status to `auth` in errorFromResponse
    // regardless of attempt number. The "one refresh-retry" only fires on the
    // first 401; a second 401 falls through to errorFromResponse.
    const { client } = buildClient([
      { status: 401, body: 'expired' },
      { status: 401, body: 'still expired' },
    ]);
    await expect(client.requestSummary(REQ)).rejects.toMatchObject({
      name: 'SummaryError',
      kind: 'auth',
    });
  });
});

describe('TwinMindSummaryClient — error mapping', () => {
  it('maps 503 -> server_5xx', async () => {
    const { client } = buildClient([{ status: 503, body: 'oops' }]);
    try {
      await client.requestSummary(REQ);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SummaryError);
      expect((err as SummaryError).kind).toBe('server_5xx');
    }
  });

  it('maps 422 -> client_4xx', async () => {
    const { client } = buildClient([{ status: 422, body: 'unprocessable' }]);
    try {
      await client.requestSummary(REQ);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SummaryError).kind).toBe('client_4xx');
    }
  });

  it('maps a fetch throw to network', async () => {
    const client = new TwinMindSummaryClient({
      config: { summaryUrl: 'https://api.example/api/v2/summary', vercelProtectionBypass: 'bypass' },
      auth: { getAccessToken: async () => 'TOK', refreshAccessToken: async () => 'TOK' },
      fetchImpl: async () => {
        const e = new Error('connect ECONNREFUSED');
        e.name = 'FetchError';
        throw e;
      },
    });
    try {
      await client.requestSummary(REQ);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SummaryError).kind).toBe('network');
    }
  });

  it('throws unknown when the response has no parseable final line', async () => {
    const { client } = buildClient([{ status: 200, body: 'garbage\nnot json' }]);
    try {
      await client.requestSummary(REQ);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SummaryError).kind).toBe('unknown');
    }
  });

  it('throws unknown when the final JSON is missing summary_id', async () => {
    const { client } = buildClient([
      { status: 200, body: JSON.stringify({ event: 'done', title: 'partial' }) },
    ]);
    try {
      await client.requestSummary(REQ);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SummaryError).kind).toBe('unknown');
      expect((err as SummaryError).message).toMatch(/summary_id/);
    }
  });
});
