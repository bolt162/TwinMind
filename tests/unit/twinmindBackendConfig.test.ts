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
      expect(r.config.vercelProtectionBypass).toBe('bypass-token');
      // Default web-login URL is supplied when env var is absent.
      expect(r.config.webLoginUrl).toContain('via_desktop');
    }
  });

  it('honors TWINMIND_WEB_LOGIN_URL override when set', () => {
    const r = resolveTwinMindBackendConfig({
      ...fullEnv(),
      TWINMIND_WEB_LOGIN_URL: 'https://staging-webapp.example/login?via_desktop',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.webLoginUrl).toBe('https://staging-webapp.example/login?via_desktop');
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
    delete env.VERCEL_PROTECTION_BYPASS;
    const r = resolveTwinMindBackendConfig(env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual(['VERCEL_PROTECTION_BYPASS']);
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
