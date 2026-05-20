import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  SettingsStore,
} from '@core/storage/SettingsStore';
import { FakeClock } from '@core/util/Clock';

describe('SettingsStore', () => {
  let dir: string;
  let store: SettingsStore;
  let clock: FakeClock;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinmind-settings-'));
    clock = new FakeClock(1_700_000_000_000);
    store = new SettingsStore(dir, clock);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes defaults on first load and returns them', () => {
    const r = store.load();
    expect(r.recoveredFromCorruption).toBe(false);
    expect(r.settings).toEqual(DEFAULT_SETTINGS);
    expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(true);
  });

  it('round-trips through save → load', () => {
    const next: typeof DEFAULT_SETTINGS = {
      ...DEFAULT_SETTINGS,
      privacy: { ...DEFAULT_SETTINGS.privacy, autoDeleteOlderThanDays: 14 },
    };
    store.save(next);
    const r = store.load();
    expect(r.settings.privacy.autoDeleteOlderThanDays).toBe(14);
  });

  it('migrates legacy advanced.asrProvider="groq" to "twinmind"', () => {
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        _version: SETTINGS_SCHEMA_VERSION,
        advanced: { asrProvider: 'groq', logLevel: 'info', vadSilenceThresholdDbfs: -50 },
      }),
      'utf8',
    );
    const r = store.load();
    expect(r.settings.advanced.asrProvider).toBe('twinmind');
  });

  it('atomic write: never leaves a half-written file (no .tmp afterwards)', () => {
    store.save(DEFAULT_SETTINGS);
    const files = fs.readdirSync(dir);
    expect(files).toContain('settings.json');
    expect(files).not.toContain('settings.json.tmp');
  });

  it('invalid JSON triggers backup-to-.broken + defaults', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ not: json', 'utf8');
    const r = store.load();
    expect(r.recoveredFromCorruption).toBe(true);
    expect(r.settings).toEqual(DEFAULT_SETTINGS);

    // Backup file exists with the timestamp suffix.
    const files = fs.readdirSync(dir);
    const broken = files.find((f) => f.startsWith('settings.json.broken.'));
    expect(broken).toBeDefined();
  });

  it('wrong _version triggers backup-to-.broken + defaults', () => {
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ _version: SETTINGS_SCHEMA_VERSION + 1, foo: 'bar' }),
      'utf8',
    );
    const r = store.load();
    expect(r.recoveredFromCorruption).toBe(true);
    expect(r.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('forward-compat merge: missing top-level keys get filled from defaults', () => {
    // A user file from an older app that didn't yet know about meetingDetection.
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ _version: SETTINGS_SCHEMA_VERSION, general: { language: 'en-US' } }),
      'utf8',
    );
    const r = store.load();
    expect(r.recoveredFromCorruption).toBe(false);
    expect(r.settings.general.language).toBe('en-US');
    // Other groups defaulted in.
    expect(r.settings.meetingDetection).toEqual(DEFAULT_SETTINGS.meetingDetection);
    expect(r.settings.advanced.vadSilenceThresholdDbfs).toBe(-50);
  });

  it('update() applies mutator and persists', () => {
    const result = store.update((s) => {
      s.advanced.logLevel = 'debug';
      s.privacy.autoDeleteOlderThanDays = 14;
    });
    expect(result.advanced.logLevel).toBe('debug');
    expect(result.privacy.autoDeleteOlderThanDays).toBe(14);

    const reloaded = store.load().settings;
    expect(reloaded.advanced.logLevel).toBe('debug');
    expect(reloaded.privacy.autoDeleteOlderThanDays).toBe(14);
  });
});
