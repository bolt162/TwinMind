import { describe, it, expect } from 'vitest';
import {
  REQUIRED_ENV_VARS,
  resolveTwinMindBackendConfig,
} from '@core/auth/twinmindBackendConfig';

function fullEnv(): NodeJS.ProcessEnv {
  return {
    FIREBASE_WEB_API_KEY: 'AIza-test',
    FIREBASE_TENANT_ID: 'TestTenant-abc',
    FIREBASE_PROJECT_ID: 'test-project',
    GOOGLE_OAUTH_CLIENT_ID: '12345.apps.googleusercontent.com',
    TWINMIND_BACKEND_URL: 'https://api-staging.example/',
    VERCEL_PROTECTION_BYPASS: 'bypass-token',
    TWINMIND_TRANSCRIBE_URL: 'https://api-staging.example/api/v2/transcribe',
    TWINMIND_SUMMARY_URL: 'https://api-staging.example/api/v2/summary',
  };
}

describe('resolveTwinMindBackendConfig', () => {
  it('returns ok when every required env var is set', () => {
    const r = resolveTwinMindBackendConfig(fullEnv());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.firebaseWebApiKey).toBe('AIza-test');
      expect(r.config.firebaseTenantId).toBe('TestTenant-abc');
      expect(r.config.firebaseProjectId).toBe('test-project');
      expect(r.config.googleOAuthClientId).toBe('12345.apps.googleusercontent.com');
      expect(r.config.vercelProtectionBypass).toBe('bypass-token');
    }
  });

  it('strips trailing slashes from the backend URL', () => {
    const r = resolveTwinMindBackendConfig({
      ...fullEnv(),
      TWINMIND_BACKEND_URL: 'https://api.example.com///',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.backendUrl).toBe('https://api.example.com');
  });

  it('reports every missing variable when none are set', () => {
    const r = resolveTwinMindBackendConfig({});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toEqual([...REQUIRED_ENV_VARS]);
    }
  });

  it('reports only the variable that is missing', () => {
    const env = fullEnv();
    delete env.GOOGLE_OAUTH_CLIENT_ID;
    const r = resolveTwinMindBackendConfig(env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual(['GOOGLE_OAUTH_CLIENT_ID']);
  });

  it('treats whitespace-only values as missing', () => {
    const r = resolveTwinMindBackendConfig({
      ...fullEnv(),
      FIREBASE_WEB_API_KEY: '   ',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toContain('FIREBASE_WEB_API_KEY');
  });

  it('trims leading/trailing whitespace from real values', () => {
    const r = resolveTwinMindBackendConfig({
      ...fullEnv(),
      FIREBASE_WEB_API_KEY: '  AIza-test  ',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.firebaseWebApiKey).toBe('AIza-test');
  });
});
