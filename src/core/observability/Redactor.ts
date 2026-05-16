/**
 * Centralized log/telemetry redaction.
 *
 * Architecture: §12.3 — what we never log: audio bytes, transcript text, API
 * keys / bearers, email, real names, full home paths. Modules never call the
 * redactor themselves; the Logger applies it as a serializer step. Keeping it
 * here means we test the patterns once and trust them everywhere.
 *
 * The redactor operates on already-stringified JSON or plain strings; PII in
 * structured fields gets caught at the field-name level (`email`, `apiKey`,
 * `password`, etc.) before serialization, and free-form strings get caught by
 * regex.
 */

const REDACTED = '<redacted>';

/**
 * Field names whose values are redacted unconditionally. Compared lowercase.
 * Adding entries here is cheap; removing them needs a security review.
 */
const SENSITIVE_FIELDS = new Set<string>([
  'apikey',
  'api_key',
  'authorization',
  'bearer',
  'cookie',
  'email',
  'firstname',
  'lastname',
  'password',
  'refresh_token',
  'set-cookie',
  'token',
  'transcript',
  'transcripttext',
  'audio',
  'pcm',
]);

/**
 * Free-form patterns matched against any string value (after field-level
 * scrubbing). Order matters only for performance — none of these overlap.
 *
 *   1. Bearer / api_key / sk_/sk- prefixed secrets in HTTP headers or logs.
 *   2. Absolute home paths — keep basenames; the rest may contain real names.
 *   3. Bare JWTs (three base64url segments separated by dots).
 */
const PATTERNS: readonly { readonly re: RegExp; readonly replace: string }[] = [
  {
    // Bearer / api_key / sk- prefixed secrets. The `[\s=:]*` allows the common
    // forms `Bearer <tok>`, `api_key=<v>`, and `sk-<v>` (no separator) to match.
    re: /\b(?:Bearer|api[_-]?key|sk[_-])[\s=:]*[A-Za-z0-9._\-]+/gi,
    replace: REDACTED,
  },
  {
    re: /\/Users\/[^/\s"']+/g,
    replace: '/Users/<user>',
  },
  {
    re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replace: REDACTED,
  },
];

/** Redact patterns inside a single string. Idempotent. */
export function redactString(s: string): string {
  let out = s;
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

/**
 * Deep-redact a structured value. We walk the tree, replacing sensitive field
 * values with `<redacted>` and running `redactString` on every leaf string.
 *
 * Cycles are not expected in log payloads; if one shows up it's a bug in the
 * caller and a `JSON.stringify` somewhere else will already have crashed. We
 * detect cycles defensively here only to avoid stack overflow during the
 * crash report itself.
 */
export function redact(value: unknown): unknown {
  const seen = new WeakSet<object>();
  return walk(value, seen);
}

function walk(v: unknown, seen: WeakSet<object>): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return redactString(v);
  if (typeof v !== 'object') return v;

  if (seen.has(v as object)) return '<cycle>';
  seen.add(v as object);

  if (Array.isArray(v)) {
    return v.map((item) => walk(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (SENSITIVE_FIELDS.has(k.toLowerCase())) {
      out[k] = REDACTED;
    } else {
      out[k] = walk(val, seen);
    }
  }
  return out;
}
