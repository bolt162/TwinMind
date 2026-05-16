/**
 * MockAsrClient — deterministic stub for tests and dev mode.
 *
 * Architecture: §9.4 — used by unit/integration tests and by the
 * `TWINMIND_ASR_PROVIDER=mock` dev override. Returns scripted responses with a
 * configurable delay; supports both per-call scripted failures and a steady
 * "happy path" mode.
 */

import { AsrError } from './AsrError';
import type {
  IAsrClient,
  TranscribeRequest,
  TranscriptSegment,
} from './IAsrClient';

export type MockScriptStep =
  | { readonly kind: 'success'; readonly text: string; readonly delayMs?: number }
  | { readonly kind: 'fail'; readonly error: AsrError; readonly delayMs?: number };

export interface MockAsrClientConfig {
  /**
   * If provided, the i-th call follows `script[i]`; subsequent calls fall back
   * to `defaultText`. If absent, every call succeeds with `defaultText`.
   */
  readonly script?: readonly MockScriptStep[];
  readonly defaultText?: string;
  readonly defaultDelayMs?: number;
  readonly model?: string;
}

export class MockAsrClient implements IAsrClient {
  readonly providerName = 'mock';
  private callIdx = 0;

  /** Construct with an optional script of per-call responses. */
  constructor(private readonly cfg: MockAsrClientConfig = {}) {}

  /** Return the next scripted response, or the default if the script is exhausted. */
  async transcribe(req: TranscribeRequest): Promise<TranscriptSegment> {
    const idx = this.callIdx++;
    const step = this.cfg.script?.[idx];
    const delay = step?.delayMs ?? this.cfg.defaultDelayMs ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    if (step && step.kind === 'fail') throw step.error;

    const text = step?.kind === 'success' ? step.text : this.cfg.defaultText ?? '';
    return {
      text,
      provider: this.providerName,
      model: this.cfg.model ?? 'mock-1',
      durationMs: req.endOffsetMs - req.startOffsetMs,
      confidence: 1.0,
    };
  }

  /** Test helper: how many transcribe() calls have been served. */
  get callCount(): number {
    return this.callIdx;
  }
}
