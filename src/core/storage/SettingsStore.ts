/**
 * SettingsStore — JSON-file-backed user settings.
 *
 * Architecture: §5 (SettingsStore owns "JSON-file-backed settings with schema
 * versioning, atomic writes"), §11.5 ("`settings.json` invalid JSON → back up to
 * `.broken`, write defaults"), §16.2 (which keys exist).
 *
 * Atomic writes: write to `settings.json.tmp` then `rename(2)`. POSIX rename is
 * atomic on the same filesystem; the file either has the old or new contents,
 * never a partial write. Windows `rename` is also atomic for our use case.
 *
 * Schema versioning: every file has a top-level `_version` field. Loaders for
 * older versions can be added later; for v1 we just back up + write defaults if
 * the field is wrong.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from '@core/util/Clock';
import type { Hotkey } from '@core/hotkey/HotkeyTypes';

/** Bump this when the on-disk shape changes incompatibly. */
export const SETTINGS_SCHEMA_VERSION = 1;

/** Full settings shape; mirrors §16.2 (Settings page). */
export interface AppSettings {
  _version: number;
  general: {
    launchAtLogin: boolean;
    showInMenuBar: boolean;
    language: string | null; // BCP-47, null = auto
  };
  recording: {
    inputDeviceId: string | null;
    systemAudioEnabled: boolean;
    /** Gain applied to mic side of the meeting-mode mixer; carried from V1 (1.2). */
    micMixGain: number;
    /** Gain applied to system side of the meeting-mode mixer; carried from V1 (0.4). */
    systemMixGain: number;
  };
  hotkeys: {
    /**
     * One configurable hotkey drives all three gestures:
     *  - press-and-hold = dictation (while held)
     *  - double-tap     = start meeting
     *  - single-tap     = stop meeting (no-op if no meeting is active)
     *
     * Structured (Wispr-style): supports L/R-specific modifiers (ShiftLeft
     * vs ShiftRight), modifier-only bindings, and modifier+key combos.
     * See HotkeyTypes.ts. The Globe (Fn) key is a separate, no-setup
     * hold-to-dictate source and doesn't appear here unless the user
     * captures it as the primary too.
     */
    primary: Hotkey | null;
  };
  dictation: {
    /**
     * User's custom dictation cleanup prompt (the "Personalize your Dictation"
     * setting). `null` = use the built-in DEFAULT_DICTATION_PROMPT. An empty /
     * whitespace-only string also falls back to the default at send time.
     */
    customPrompt: string | null;
  };
  privacy: {
    /** Whether to send audio to the configured ASR provider. Off → fully local-no-op. */
    sendAudioToProvider: boolean;
    /** §11.7: retention horizon for non-completed audio. Min 7, default 30. */
    autoDeleteOlderThanDays: number;
  };
  meetingDetection: {
    enabled: boolean;
    /** When true, replace the notification with silent auto-recording. */
    autoStart: boolean;
  };
  advanced: {
    logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
    /**
     * 'twinmind' is the real backend; 'mock' is for tests / dev. Groq was
     * removed when we unified on the TwinMind backend.
     */
    asrProvider: 'twinmind' | 'mock';
    /** §7.11: RMS dBFS threshold; chunks below this skip the API call. */
    vadSilenceThresholdDbfs: number;
  };
}

/**
 * NOTE on machine-scoped state: `onboardingCompletedAt` used to live here.
 * It is now stored in `<userData>/global.db` (`GlobalDb.wizard`) so it is
 * shared across all users on the machine — permissions are macOS-scoped, so
 * the wizard's gate is too. Read via `wizard.getStatus` IPC.
 */

/** Application defaults. Used on first run and when the file is invalid. */
export const DEFAULT_SETTINGS: AppSettings = {
  _version: SETTINGS_SCHEMA_VERSION,
  general: { launchAtLogin: false, showInMenuBar: true, language: null },
  recording: {
    inputDeviceId: null,
    systemAudioEnabled: true,
    micMixGain: 1.2,
    systemMixGain: 0.4,
  },
  hotkeys: { primary: null },
  dictation: { customPrompt: null },
  privacy: { sendAudioToProvider: true, autoDeleteOlderThanDays: 30 },
  meetingDetection: { enabled: true, autoStart: false },
  advanced: { logLevel: 'info', asrProvider: 'twinmind', vadSilenceThresholdDbfs: -50 },
};

/** Result of a `load()` call: settings plus a flag if a `.broken` backup was made. */
export interface LoadResult {
  readonly settings: AppSettings;
  /** True iff the existing file was invalid and we wrote defaults + a `.broken` backup. */
  readonly recoveredFromCorruption: boolean;
}

export class SettingsStore {
  private readonly filePath: string;
  private readonly tmpPath: string;

  /**
   * Construct over the directory that should contain `settings.json`. Files
   * created here will respect the directory's mode; pass `userData/` from the
   * Electron `app.getPath('userData')` in production.
   */
  constructor(dir: string, private readonly clock: Clock) {
    this.filePath = path.join(dir, 'settings.json');
    this.tmpPath = path.join(dir, 'settings.json.tmp');
  }

  /**
   * Load settings from disk. If the file is missing, write defaults and return
   * them. If the file is invalid JSON or has the wrong schema version, back
   * it up to `.broken.<ts>.json` and return defaults.
   */
  load(): LoadResult {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        this.save(DEFAULT_SETTINGS);
        return { settings: DEFAULT_SETTINGS, recoveredFromCorruption: false };
      }
      throw e;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.backupAndReset();
      return { settings: DEFAULT_SETTINGS, recoveredFromCorruption: true };
    }

    if (!isValidShape(parsed)) {
      this.backupAndReset();
      return { settings: DEFAULT_SETTINGS, recoveredFromCorruption: true };
    }

    // Forward-compat: deep-merge defaults so new keys added in code show up
    // even if the on-disk file predates them. Existing user values win.
    const merged = mergeDefaults(parsed as Partial<AppSettings>);
    return { settings: merged, recoveredFromCorruption: false };
  }

  /**
   * Persist `settings` atomically. Writes to `.tmp`, fsyncs, then renames over
   * the real path. If the rename fails the old contents stay intact.
   */
  save(settings: AppSettings): void {
    const body = JSON.stringify({ ...settings, _version: SETTINGS_SCHEMA_VERSION }, null, 2);

    const fd = fs.openSync(this.tmpPath, 'w', 0o600);
    try {
      fs.writeFileSync(fd, body, 'utf8');
      // fsync ensures the bytes hit the platter before the rename; without it
      // a power failure could leave us with an empty/short file after rename.
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(this.tmpPath, this.filePath);
  }

  /** Convenience: load, mutate, save. Returns the new settings. */
  update(mutator: (s: AppSettings) => void): AppSettings {
    const { settings } = this.load();
    mutator(settings);
    this.save(settings);
    return settings;
  }

  /**
   * Move the existing file aside to `.broken.<ts>.json` (best-effort) and
   * write fresh defaults. The timestamp suffix means we never overwrite a
   * previous broken file.
   */
  private backupAndReset(): void {
    const ts = this.clock.now();
    const brokenPath = `${this.filePath}.broken.${ts}.json`;
    try {
      fs.renameSync(this.filePath, brokenPath);
    } catch {
      // Best-effort: if the rename fails (e.g., parallel cleanup) we still
      // need to recover. Falling through to save() is the safe path.
    }
    this.save(DEFAULT_SETTINGS);
  }
}

/** Top-level shape check: must be an object with `_version === SETTINGS_SCHEMA_VERSION`. */
function isValidShape(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return obj._version === SETTINGS_SCHEMA_VERSION;
}

/** Deep-merge user values over defaults so new code-added keys appear. */
function mergeDefaults(user: Partial<AppSettings>): AppSettings {
  return {
    _version: SETTINGS_SCHEMA_VERSION,
    general: { ...DEFAULT_SETTINGS.general, ...(user.general ?? {}) },
    recording: { ...DEFAULT_SETTINGS.recording, ...(user.recording ?? {}) },
    hotkeys: mergeHotkeys(user.hotkeys),
    dictation: { ...DEFAULT_SETTINGS.dictation, ...(user.dictation ?? {}) },
    privacy: { ...DEFAULT_SETTINGS.privacy, ...(user.privacy ?? {}) },
    meetingDetection: {
      ...DEFAULT_SETTINGS.meetingDetection,
      ...(user.meetingDetection ?? {}),
    },
    advanced: mergeAdvanced(user.advanced),
  };
}

/**
 * Migrate `advanced.asrProvider`: legacy installs may have `'groq'` saved.
 * We map it to the new default ('twinmind') silently so a returning user
 * starts on the supported backend instead of erroring out.
 */
function mergeAdvanced(
  user: Partial<AppSettings>['advanced'],
): AppSettings['advanced'] {
  const merged = { ...DEFAULT_SETTINGS.advanced, ...(user ?? {}) } as AppSettings['advanced'] & {
    asrProvider: string;
  };
  if (merged.asrProvider !== 'twinmind' && merged.asrProvider !== 'mock') {
    merged.asrProvider = 'twinmind';
  }
  return merged as AppSettings['advanced'];
}

/**
 * Migrate hotkeys to the structured Hotkey format.
 *
 *   - { primary: Hotkey | null }  → kept as-is.
 *   - { primary: "Cmd+Shift+D" }  → dropped to null. The old string lacks
 *     L/R info and the user must re-capture in the new picker.
 *   - { dictation, meetingStartStop } (oldest legacy) → also dropped.
 */
function mergeHotkeys(user: Partial<AppSettings>['hotkeys']): AppSettings['hotkeys'] {
  if (!user) return { ...DEFAULT_SETTINGS.hotkeys };
  const u = user as Partial<{
    primary: Hotkey | string | null;
    dictation: string | null;
    meetingStartStop: string | null;
  }>;
  if (u.primary && typeof u.primary === 'object' && Array.isArray((u.primary as Hotkey).modifiers)) {
    return { primary: u.primary as Hotkey };
  }
  // Anything else (legacy string, old two-key shape, malformed) → reset.
  return { primary: null };
}
