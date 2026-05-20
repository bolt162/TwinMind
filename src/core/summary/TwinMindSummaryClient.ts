/**
 * TwinMindSummaryClient — fires the per-meeting summary call after all
 * chunks have transcribed.
 *
 * V1 reference: `audioManager.js:_requestSummary` + `ipc/transcriptionHandlers.js`.
 * V2 differences from V1:
 *   - The `transcript` field is intentionally NOT sent. The backend already
 *     has every chunk's text keyed by `meeting_id` (we passed it as
 *     `meeting_id` on each transcribe call) so it builds the summary
 *     server-side from those records.
 *   - We fire AFTER all chunks complete (via TranscriptionUx's signal),
 *     not at recording-stop. V1 chunks uploaded inline so the two events
 *     were near-simultaneous; in V2 they aren't.
 *
 * Response: backend returns newline-delimited JSON (progress events plus
 * a final summary record). We buffer the whole body and pick the last
 * line that parses as JSON with a `summary_id` — same approach as V1.
 *
 * Auth: same shape as TwinMindAsrClient. 401 triggers one refresh-and-retry
 * before classifying as `auth`.
 */

import { type Logger, noopLogger } from '@core/observability/Logger';
import type { TwinMindBackendConfig } from '@core/auth/twinmindBackendConfig';

/** Per-meeting input. Times are epoch ms from the session row. */
export interface SummaryRequest {
  readonly sessionId: string;
  readonly startedAt: number;
  readonly endedAt: number;
}

/** Final summary record the backend returns. */
export interface SummaryResult {
  readonly summaryId: string;
  readonly title?: string;
}

/** Normalized error classification — small, closed set. */
export type SummaryErrorKind =
  | 'auth'
  | 'network'
  | 'timeout'
  | 'server_5xx'
  | 'client_4xx'
  | 'unknown';

export class SummaryError extends Error {
  constructor(
    public readonly kind: SummaryErrorKind,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SummaryError';
  }
}

/** Same credential contract used by TwinMindAsrClient. */
export interface SummaryCredentialsProvider {
  getAccessToken(): Promise<string>;
  refreshAccessToken(): Promise<string>;
}

export interface TwinMindSummaryClientDeps {
  readonly config: Pick<TwinMindBackendConfig, 'summaryUrl' | 'vercelProtectionBypass'>;
  readonly auth: SummaryCredentialsProvider;
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Request timeout (ms). Summaries can take a while — default is 60 000. */
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEVICE_USED = 'twinmind_desktop';

export class TwinMindSummaryClient {
  private readonly config: TwinMindSummaryClientDeps['config'];
  private readonly auth: SummaryCredentialsProvider;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(deps: TwinMindSummaryClientDeps) {
    this.config = deps.config;
    this.auth = deps.auth;
    const f = deps.fetchImpl ?? globalThis.fetch;
    if (typeof f !== 'function') {
      throw new Error('TwinMindSummaryClient: no fetch impl available (Node < 18?)');
    }
    this.fetchImpl = f;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = deps.logger ?? noopLogger;
  }

  async requestSummary(req: SummaryRequest): Promise<SummaryResult> {
    let accessToken: string;
    try {
      accessToken = await this.auth.getAccessToken();
    } catch (err) {
      throw new SummaryError('auth', `failed to get access token: ${describeError(err)}`, err);
    }

    let resp = await this.doRequest(req, accessToken);

    if (resp.status === 401 || resp.status === 403) {
      this.logger.info('twinmind summary 401; refreshing token');
      try {
        accessToken = await this.auth.refreshAccessToken();
      } catch (err) {
        throw new SummaryError('auth', `token refresh failed: ${describeError(err)}`, err);
      }
      resp = await this.doRequest(req, accessToken);
    }

    if (!resp.ok) {
      throw await this.errorFromResponse(resp);
    }

    const body = await resp.text();
    const final = parseFinalSummaryLine(body);
    if (!final) {
      throw new SummaryError(
        'unknown',
        'summary response had no parseable final JSON line',
      );
    }
    if (!final.summary_id) {
      throw new SummaryError(
        'unknown',
        'summary response was missing summary_id on the final line',
      );
    }
    return {
      summaryId: final.summary_id,
      ...(final.title ? { title: final.title } : {}),
    };
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private async doRequest(req: SummaryRequest, accessToken: string): Promise<Response> {
    const startDate = new Date(req.startedAt);
    const endDate = new Date(req.endedAt);
    const durationMs = Math.max(0, req.endedAt - req.startedAt);
    // V1 payload, MINUS `transcript` (the backend reconstructs from the
    // per-chunk records it already has under this meeting_id).
    const payload = {
      meetingId: req.sessionId,
      start_time: startDate.toISOString(),
      end_time: endDate.toISOString(),
      start_time_local: startDate.toLocaleString('en-US'),
      end_time_local: endDate.toLocaleString('en-US'),
      log_data: true,
      personalization: '',
      metadata: {
        deviceType: DEVICE_USED,
        log_Audio: 'false',
        durationMs,
        durationSeconds: Math.round(durationMs / 1000),
        contextualInfo: '',
        location: {},
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(this.config.summaryUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'x-vercel-protection-bypass': this.config.vercelProtectionBypass,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (cause) {
      const kind: SummaryErrorKind =
        (cause as { name?: string } | null)?.name === 'AbortError' ? 'timeout' : 'network';
      throw new SummaryError(kind, `fetch failed: ${describeError(cause)}`, cause);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async errorFromResponse(resp: Response): Promise<SummaryError> {
    let kind: SummaryErrorKind;
    if (resp.status === 401 || resp.status === 403) kind = 'auth';
    else if (resp.status === 408) kind = 'timeout';
    else if (resp.status >= 500 && resp.status < 600) kind = 'server_5xx';
    else if (resp.status >= 400 && resp.status < 500) kind = 'client_4xx';
    else kind = 'unknown';

    let bodySnippet = '';
    try {
      const t = await resp.text();
      bodySnippet = t.length > 200 ? `${t.slice(0, 200)}…` : t;
    } catch {
      // ignore
    }
    this.logger.warn('twinmind summary non-2xx', { status: resp.status, kind });
    return new SummaryError(kind, `summary ${resp.status}: ${bodySnippet || '(no body)'}`);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Shape we look for on the final NDJSON line — only the fields we use. */
interface FinalSummaryJson {
  readonly summary_id?: string;
  readonly title?: string;
  readonly meeting_id?: string;
}

/**
 * Walk the body backwards line-by-line; return the first line that parses
 * as JSON with a `summary_id`. Skips trailing blanks and progress events.
 * Exported for tests.
 */
export function parseFinalSummaryLine(body: string): FinalSummaryJson | null {
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!) as FinalSummaryJson;
      if (typeof parsed.summary_id === 'string' && parsed.summary_id.length > 0) {
        return parsed;
      }
    } catch {
      // skip malformed lines
    }
  }
  // Last-ditch: maybe a single line WITHOUT summary_id but at least valid JSON;
  // caller will surface "missing summary_id" as an error.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]!) as FinalSummaryJson;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'unknown error';
}
