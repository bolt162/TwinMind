/**
 * TwinMindAsrClient — IAsrClient over the TwinMind backend.
 *
 * Architecture: §9.1 (interface), §9.6 (each client owns its own credential
 * strategy). Sits in front of the TwinMind transcribe endpoint; uses an
 * injected `AsrCredentialsProvider` to fetch a fresh access token per call.
 *
 * Wire shape (matches V1's transcribe call):
 *   POST <transcribeUrl>
 *   Authorization: Bearer <firebase id token>
 *   Body (multipart/form-data):
 *     file:           the chunk's WAV file
 *     device_used:    'twinmind_desktop'
 *     meeting_id:     the V2 session id (groups multiple chunks of one recording)
 *     chunk_duration: chunk length in seconds
 *     log_data:       'true'        (backend-side telemetry consent)
 *     log_audio:      'false'       (do NOT store raw audio server-side)
 *
 * Response: backends return either `{ transcript: "…" }` or `{ text: "…" }`;
 * we accept both. Optional `words` and `language` fields are mapped if
 * present.
 *
 * Auth handling:
 *   - 401: refresh the token ONCE and retry. If still 401, throw
 *     AsrError('auth') so UploadQueue routes the chunk to failed_permanent
 *     and the UI surfaces "Sign in to continue."
 *   - All other HTTP failures map through `classifyHttpStatus` to the
 *     normalized AsrError taxonomy.
 *
 * Timeouts / retries: a hard 30 s timeout per request (same as Groq). The
 * UploadQueue handles retry scheduling and backoff at the queue layer —
 * this client just maps errors.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AsrError, classifyHttpStatus, type AsrErrorClass } from './AsrError';
import type {
  IAsrClient,
  TranscribeRequest,
  TranscriptSegment,
  WordTiming,
} from './IAsrClient';
import type { Logger } from '@core/observability/Logger';
import { noopLogger } from '@core/observability/Logger';
import type { TwinMindBackendConfig } from '@core/auth/twinmindBackendConfig';

/** What the client needs to mint + refresh tokens. Matches TwinMindAuthProvider. */
export interface AsrCredentialsProvider {
  getAccessToken(): Promise<string>;
  /** Force-refresh now. Called on the 401 path. */
  refreshAccessToken(): Promise<string>;
}

export interface TwinMindAsrClientDeps {
  /** Resolved backend config — endpoint + bypass + per-mode model identifiers. */
  readonly config: Pick<
    TwinMindBackendConfig,
    'transcribeUrl' | 'vercelProtectionBypass' | 'dictationModel' | 'meetingModel'
  >;
  readonly auth: AsrCredentialsProvider;
  /** Default `globalThis.fetch`; test code passes a mock. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Request timeout (ms). Default 30 000. */
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEVICE_USED = 'twinmind_desktop';

/** Shape of the response body we tolerate from the TwinMind transcribe endpoint. */
interface TwinMindResponse {
  readonly transcript?: string;
  readonly text?: string;
  readonly language?: string;
  readonly confidence?: number;
  readonly words?: ReadonlyArray<{
    readonly word: string;
    readonly start: number;
    readonly end: number;
  }>;
  /** Actual model the backend ran, when the response includes it (V1 reads this). */
  readonly modelVersion?: string;
  readonly model?: string;
  /**
   * Locale-formatted wall-clock time the backend assigned to this chunk
   * (e.g. `"02/06/2026, 13:30:48"`). The renderer slices HH:MM for the
   * meeting transcript view. Absent on backends that don't emit it.
   */
  readonly start_time_local?: string;
}

export class TwinMindAsrClient implements IAsrClient {
  readonly providerName = 'twinmind';

  private readonly config: TwinMindAsrClientDeps['config'];
  private readonly auth: AsrCredentialsProvider;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(deps: TwinMindAsrClientDeps) {
    this.config = deps.config;
    this.auth = deps.auth;
    const f = deps.fetchImpl ?? globalThis.fetch;
    if (typeof f !== 'function') {
      throw new Error('TwinMindAsrClient: no fetch impl available (Node < 18?)');
    }
    this.fetchImpl = f;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = deps.logger ?? noopLogger;
  }

  async transcribe(req: TranscribeRequest): Promise<TranscriptSegment> {
    // Read audio once; we may need to retry the upload after a token refresh.
    const audioBytes = await fs.promises.readFile(req.audioPath);
    const filename = path.basename(req.audioPath);

    let accessToken: string;
    try {
      accessToken = await this.auth.getAccessToken();
    } catch (err) {
      throw new AsrError('auth', `failed to get access token: ${describeError(err)}`, err);
    }

    let resp = await this.doRequest(req, audioBytes, filename, accessToken);

    // One-shot 401 refresh-retry path. Anything else propagates as-is.
    if (resp.status === 401 || resp.status === 403) {
      this.logger.info('twinmind asr 401; refreshing token');
      try {
        accessToken = await this.auth.refreshAccessToken();
      } catch (err) {
        throw new AsrError('auth', `token refresh failed: ${describeError(err)}`, err);
      }
      resp = await this.doRequest(req, audioBytes, filename, accessToken);
    }

    if (!resp.ok) {
      throw await this.errorFromResponse(resp);
    }

    let json: TwinMindResponse;
    try {
      json = (await resp.json()) as TwinMindResponse;
    } catch (err) {
      throw new AsrError('unknown', 'failed to parse TwinMind response body', err);
    }

    return this.toSegment(req, json);
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private async doRequest(
    req: TranscribeRequest,
    audioBytes: Buffer,
    filename: string,
    accessToken: string,
  ): Promise<Response> {
    const form = new FormData();
    // Buffer → Uint8Array for the Blob ctor; Node 18+ accepts both but the
    // type signature is friendlier with the explicit conversion.
    form.append(
      'file',
      new Blob([new Uint8Array(audioBytes)], { type: 'audio/wav' }),
      filename,
    );
    form.append('device_used', DEVICE_USED);
    form.append('meeting_id', req.sessionId);
    form.append(
      'chunk_duration',
      String(Math.max(0, Math.round((req.endOffsetMs - req.startOffsetMs) / 1000))),
    );
    // Per-mode model selection. Meeting mode pins `twinmind-pro` (V1
    // behavior). Dictation now OMITS the `model` field entirely so the
    // backend's `/api/v2/transcribe/choose` endpoint picks its default —
    // we're testing whether `twinmind-fast` was the cause of dropped
    // first-words. To revert: re-add the dictation branch sending
    // `this.config.dictationModel`.
    if (req.mode === 'meeting') {
      form.append('model', this.config.meetingModel);
    }
    // Telemetry: opt INTO server-side request metadata so the backend can
    // diagnose failures, but explicitly opt OUT of audio retention. The
    // backend honors these — matches V1's defaults.
    form.append('log_data', 'true');
    form.append('log_audio', 'false');
    if (req.language) form.append('language', req.language);
    if (req.contextHint) form.append('prompt', req.contextHint);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(this.config.transcribeUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          // Pass through the Vercel deployment-protection token. It's not a
          // user secret; harmless if the backend ignores it.
          'x-vercel-protection-bypass': this.config.vercelProtectionBypass,
        },
        body: form,
        signal: controller.signal,
      });
    } catch (cause) {
      // AbortError vs network error; queue treats both as retryable.
      const kind: AsrErrorClass =
        (cause as { name?: string } | null)?.name === 'AbortError' ? 'timeout' : 'network';
      throw new AsrError(kind, `fetch failed: ${describeError(cause)}`, cause);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async errorFromResponse(resp: Response): Promise<AsrError> {
    const kind = classifyHttpStatus(resp.status);
    const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'));
    let bodySnippet = '';
    try {
      const t = await resp.text();
      bodySnippet = t.length > 200 ? `${t.slice(0, 200)}…` : t;
    } catch {
      // ignore
    }
    this.logger.warn('twinmind non-2xx', { status: resp.status, kind });
    return new AsrError(
      kind,
      `TwinMind ${resp.status}: ${bodySnippet || '(no body)'}`,
      undefined,
      retryAfterMs,
    );
  }

  private toSegment(req: TranscribeRequest, json: TwinMindResponse): TranscriptSegment {
    const text = (json.transcript ?? json.text ?? '').toString();
    const words: WordTiming[] | undefined = json.words?.map((w) => ({
      word: w.word,
      startMs: req.startOffsetMs + Math.round(w.start * 1000),
      endMs: req.startOffsetMs + Math.round(w.end * 1000),
    }));
    // Prefer whatever the backend reports it ran (V1 reads `modelVersion`;
    // some deployments use `model` as the response field). Fall back to a
    // mode-derived tag so transcripts always have a meaningful display
    // value — for dictation we no longer pin a model, so the fallback is
    // a generic label rather than the unused config value.
    const fallbackModel =
      req.mode === 'dictation' ? 'twinmind-default' : this.config.meetingModel;
    const reportedModel = json.modelVersion ?? json.model ?? fallbackModel;
    return {
      text,
      ...(words ? { words } : {}),
      ...(typeof json.confidence === 'number' ? { confidence: json.confidence } : {}),
      provider: this.providerName,
      model: reportedModel,
      durationMs: req.endOffsetMs - req.startOffsetMs,
      ...(json.language ? { language: json.language } : {}),
      ...(typeof json.start_time_local === 'string' && json.start_time_local.length > 0
        ? { clockTimeLocal: json.start_time_local }
        : {}),
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const ts = Date.parse(trimmed);
  return Number.isFinite(ts) ? Math.max(0, ts - Date.now()) : null;
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'unknown error';
}
