import { describe, it, expect } from 'vitest';
import { redact, redactString } from '@core/observability/Redactor';

describe('Redactor', () => {
  describe('field-name redaction', () => {
    it('redacts known sensitive fields regardless of case', () => {
      const r = redact({
        apiKey: 'gsk_real_secret',
        Authorization: 'Bearer abc',
        EMAIL: 'a@b.com',
        nested: { token: 'xyz', safe: 'keep me' },
      }) as Record<string, unknown>;
      expect(r.apiKey).toBe('<redacted>');
      expect(r.Authorization).toBe('<redacted>');
      expect(r.EMAIL).toBe('<redacted>');
      expect((r.nested as Record<string, unknown>).token).toBe('<redacted>');
      expect((r.nested as Record<string, unknown>).safe).toBe('keep me');
    });

    it('walks arrays', () => {
      const r = redact([{ apiKey: 's' }, 'keep me']) as unknown[];
      expect((r[0] as Record<string, unknown>).apiKey).toBe('<redacted>');
      expect(r[1]).toBe('keep me');
    });
  });

  describe('pattern-based redaction inside free-form strings', () => {
    it('redacts Bearer tokens', () => {
      expect(redactString('Authorization: Bearer abc.def.ghi')).toBe(
        'Authorization: <redacted>',
      );
    });
    it('redacts api_key= and sk- prefixed secrets', () => {
      expect(redactString('?api_key=gsk_real')).toBe('?<redacted>');
      expect(redactString('used sk-1234567890')).toBe('used <redacted>');
    });
    it('redacts JWT-shaped tokens', () => {
      const jwt = 'eyJhbGciOi.eyJzdWIi.signature';
      expect(redactString(`token=${jwt}`)).toBe('token=<redacted>');
    });
    it('redacts home-dir paths but preserves basenames', () => {
      expect(redactString('open /Users/alice/file.wav')).toBe(
        'open /Users/<user>/file.wav',
      );
    });
    it('is idempotent', () => {
      const once = redactString('Bearer abc and /Users/bob/x');
      expect(redactString(once)).toBe(once);
    });
  });

  describe('safety guarantees', () => {
    it('passes primitives through unchanged', () => {
      expect(redact(42)).toBe(42);
      expect(redact(null)).toBeNull();
      expect(redact(undefined)).toBeUndefined();
      expect(redact(true)).toBe(true);
    });
    it('handles cycles without overflowing the stack', () => {
      const a: Record<string, unknown> = {};
      a.self = a;
      expect(() => redact(a)).not.toThrow();
    });
  });
});
