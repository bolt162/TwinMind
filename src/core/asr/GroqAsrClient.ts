/**
 * GroqAsrClient — Whisper-via-Groq HTTP impl of IAsrClient.
 *
 * Architecture: §9.2.
 *   - Reads the chunk WAV from `audioPath` (16 kHz mono, well under Groq's 25 MB limit).
 *   - Multipart POST to `/openai/v1/audio/transcriptions`.
 *   - `response_format=verbose_json` to get word timestamps.
 *   - API key obtained from `getApiKey` per request — settings UI may rotate it
 *     mid-session; we don't cache.
 *   - Maps provider errors to the `AsrError` taxonomy.
 *   - Honors `Retry-After` (seconds or HTTP-date) on 429.
 *
 * The `fetch` impl is injected so tests can mock without nock or a real server.
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

export interface GroqConfig {
  /** Default `https://api.groq.com/openai/v1`. Overridable for staging. */
  readonly baseUrl?: string;
  /** Groq Whisper model id; default `whisper-large-v3`. */
  readonly model?: string;
  /** Read timeout for the upload (ms). Default 30 000 (§11.2). */
  readonly timeoutMs?: number;
}

export interface GroqAsrClientDeps {
  readonly config: GroqConfig;
  /** Read the user's Groq API key at request time. Returning null → auth error. */
  readonly getApiKey: () => string | null;
  /** Defaults to `globalThis.fetch`; test code passes a mock. */
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly logger?: Logger;
}

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'whisper-large-v3';
const DEFAULT_TIMEOUT_MS = 30_000;

interface GroqVerboseJson {
  readonly text?: string;
  readonly language?: string;
  readonly duration?: number;
  readonly words?: ReadonlyArray<{ word: string; start: number; end: number }>;
}

export class GroqAsrClient implements IAsrClient {
  readonly providerName = 'groq';

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly logger: Logger;
  private readonly getApiKey: () => string | null;

  /** Configure with HTTP/credentials deps; throws if no fetch is available. */
  constructor(deps: GroqAsrClientDeps) {
    this.baseUrl = deps.config.baseUrl ?? DEFAULT_BASE_URL;
    this.model = deps.config.model ?? DEFAULT_MODEL;
    this.timeoutMs = deps.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('GroqAsrClient: no fetch impl available (Node < 18?)');
    }
    this.logger = deps.logger ?? noopLogger;
    this.getApiKey = deps.getApiKey;
  }

  /** Transcribe one chunk. Throws AsrError on any failure path. */
  async transcribe(req: TranscribeRequest): Promise<TranscriptSegment> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new AsrError('auth', 'no Groq API key configured');
    }

    const body = await this.buildFormData(req);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body,
        signal: controller.signal,
      });
    } catch (cause) {
      // AbortError vs network error; the queue treats both as retryable.
      const kind: AsrErrorClass =
        (cause as { name?: string } | null)?.name === 'AbortError' ? 'timeout' : 'network';
      throw new AsrError(kind, `fetch failed: ${describeError(cause)}`, cause);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!resp.ok) {
      throw await this.errorFromResponse(resp);
    }

    let json: GroqVerboseJson;
    try {
      json = (await resp.json()) as GroqVerboseJson;
    } catch (cause) {
      throw new AsrError('unknown', 'failed to parse Groq response body', cause);
    }

    return this.toSegment(req, json);
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  /** Build the multipart form body for one transcribe request. */
  private async buildFormData(req: TranscribeRequest): Promise<FormData> {
    const bytes = await fs.promises.readFile(req.audioPath);
    const filename = path.basename(req.audioPath);
    const form = new FormData();
    form.append('model', this.model);
    form.append('response_format', 'verbose_json');
    if (req.language) form.append('language', req.language);
    if (req.contextHint) form.append('prompt', req.contextHint);
    // Cast to Blob for the FormData API; Node 18+ provides a global Blob.
    form.append('file', new Blob([bytes], { type: 'audio/wav' }), filename);
    return form;
  }

  /** Map a non-2xx Response to an AsrError using the taxonomy. */
  private async errorFromResponse(resp: Response): Promise<AsrError> {
    const kind = classifyHttpStatus(resp.status);
    const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'));
    let bodySnippet = '';
    try {
      // Cap the body in the error message so we don't echo unbounded server output.
      const t = await resp.text();
      bodySnippet = t.length > 200 ? `${t.slice(0, 200)}…` : t;
    } catch {
      // ignore
    }
    this.logger.warn('groq non-2xx', { status: resp.status, kind });
    return new AsrError(
      kind,
      `Groq ${resp.status}: ${bodySnippet || '(no body)'}`,
      undefined,
      retryAfterMs,
    );
  }

  /** Convert Groq's verbose_json into our normalized TranscriptSegment shape. */
  private toSegment(req: TranscribeRequest, json: GroqVerboseJson): TranscriptSegment {
    const words: WordTiming[] | undefined = json.words?.map((w) => ({
      word: w.word,
      // Groq returns seconds; we store ms absolute to the session start.
      startMs: req.startOffsetMs + Math.round(w.start * 1000),
      endMs: req.startOffsetMs + Math.round(w.end * 1000),
    }));
    return {
      text: json.text ?? '',
      ...(words ? { words } : {}),
      provider: this.providerName,
      model: this.model,
      durationMs: req.endOffsetMs - req.startOffsetMs,
      ...(json.language ? { language: json.language } : {}),
    };
  }
}

/**
 * Parse the `Retry-After` header. Supports both delta-seconds and HTTP-date.
 * Returns null if absent or unparsable so the RetryPolicy falls back to
 * its own backoff curve (§11.2).
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const ts = Date.parse(trimmed);
  if (Number.isFinite(ts)) {
    return Math.max(0, ts - Date.now());
  }
  return null;
}

/** Best-effort message extraction from an unknown thrown value. */
function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'unknown error';
}
