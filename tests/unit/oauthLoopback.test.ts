import { describe, it, expect } from 'vitest';
import {
  GOOGLE_OAUTH_SCOPES,
  buildGoogleAuthUrl,
  extractTokensFromFragmentBody,
} from '@core/auth/oauthLoopback';

describe('buildGoogleAuthUrl', () => {
  it('includes the required hybrid-flow params', () => {
    const url = new URL(
      buildGoogleAuthUrl({
        clientId: 'abc.apps.googleusercontent.com',
        redirectUri: 'http://127.0.0.1:3000/auth/callback',
        nonce: 'NONCE-1',
        state: 'STATE-1',
      }),
    );
    expect(url.host).toBe('accounts.google.com');
    expect(url.pathname).toBe('/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('abc.apps.googleusercontent.com');
    expect(url.searchParams.get('response_type')).toBe('code id_token');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:3000/auth/callback',
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('nonce')).toBe('NONCE-1');
    expect(url.searchParams.get('state')).toBe('STATE-1');
  });

  it('joins the default scopes with spaces', () => {
    const url = new URL(
      buildGoogleAuthUrl({
        clientId: 'x',
        redirectUri: 'http://127.0.0.1/cb',
        nonce: 'n',
        state: 's',
      }),
    );
    expect(url.searchParams.get('scope')).toBe(GOOGLE_OAUTH_SCOPES.join(' '));
  });

  it('respects a custom scope list', () => {
    const url = new URL(
      buildGoogleAuthUrl({
        clientId: 'x',
        redirectUri: 'http://127.0.0.1/cb',
        nonce: 'n',
        state: 's',
        scopes: ['openid', 'email'],
      }),
    );
    expect(url.searchParams.get('scope')).toBe('openid email');
  });
});

describe('extractTokensFromFragmentBody', () => {
  it('extracts code + id_token when state matches', () => {
    const body = 'code=AUTHCODE&id_token=IDTOK&state=STATE-1&token_type=Bearer';
    const r = extractTokensFromFragmentBody(body, 'STATE-1');
    expect(r.code).toBe('AUTHCODE');
    expect(r.idToken).toBe('IDTOK');
  });

  it('throws when state mismatches (CSRF guard)', () => {
    const body = 'code=A&id_token=B&state=STATE-EVIL';
    expect(() => extractTokensFromFragmentBody(body, 'STATE-GOOD')).toThrow(
      /state mismatch/,
    );
  });

  it('throws when state is missing', () => {
    const body = 'code=A&id_token=B';
    expect(() => extractTokensFromFragmentBody(body, 'STATE-GOOD')).toThrow(
      /state mismatch/,
    );
  });

  it('throws when code is missing', () => {
    const body = 'id_token=B&state=S';
    expect(() => extractTokensFromFragmentBody(body, 'S')).toThrow(/missing required tokens/);
  });

  it('throws when id_token is missing', () => {
    const body = 'code=A&state=S';
    expect(() => extractTokensFromFragmentBody(body, 'S')).toThrow(/missing required tokens/);
  });

  it('throws when the provider reports an error', () => {
    const body = 'error=access_denied&state=S';
    expect(() => extractTokensFromFragmentBody(body, 'S')).toThrow(/access_denied/);
  });
});
