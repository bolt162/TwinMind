/**
 * SettingsPage — read + write app settings via IPC.
 *
 * Mirrors `AppSettings` from SettingsStore but works against the
 * structurally-typed payload that crosses IPC. Saves on every change (with
 * a small debounce visual via `pendingSave`); no explicit Save button.
 */

import { useEffect, useState } from 'react';
import { useSettings } from '../hooks/useSettings';
import { cn } from './cn';
import { HotkeyCaptureField } from './HotkeyCaptureField';
import type { Hotkey } from '@core/hotkey/HotkeyTypes';

export function SettingsPage() {
  const { settings, loading, save } = useSettings();
  const [pendingSave, setPendingSave] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (settings) setDraft(settings);
  }, [settings]);

  if (loading || !draft) {
    return <div className="text-sm text-zinc-500">Loading settings…</div>;
  }

  // Save helper: merges + saves through IPC. The settings object is opaque
  // at the renderer level; we mutate by path.
  const setPath = async (path: string, value: unknown) => {
    const next = structuredClone(draft);
    let cursor: Record<string, unknown> = next as Record<string, unknown>;
    const parts = path.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i]!;
      if (typeof cursor[k] !== 'object' || cursor[k] === null) cursor[k] = {};
      cursor = cursor[k] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]!] = value;
    setDraft(next);
    setPendingSave(true);
    try {
      await save(next as Parameters<typeof save>[0]);
    } finally {
      setPendingSave(false);
    }
  };

  const advanced = (draft.advanced ?? {}) as Record<string, unknown>;
  const recording = (draft.recording ?? {}) as Record<string, unknown>;
  const meeting = (draft.meetingDetection ?? {}) as Record<string, unknown>;
  const hotkeys = (draft.hotkeys ?? {}) as Record<string, unknown>;

  return (
    <div className="space-y-6">
      {pendingSave && <div className="text-xs text-zinc-500">Saving…</div>}

      <Section title="Meeting auto-detection">
        <Toggle
          label="Detect when another app opens the mic"
          checked={Boolean(meeting.enabled ?? true)}
          onChange={(v) => setPath('meetingDetection.enabled', v)}
        />
        <Toggle
          label="Auto-start recording on detection (no prompt)"
          checked={Boolean(meeting.autoStart ?? false)}
          onChange={(v) => setPath('meetingDetection.autoStart', v)}
        />
      </Section>

      <Section title="Recording">
        <InputDeviceField
          value={(recording.inputDeviceId as string | null) ?? null}
          onChange={(v) => setPath('recording.inputDeviceId', v)}
        />
      </Section>

      <Section title="Hotkey">
        <div className="space-y-1">
          <span className="block text-sm">Click below to change hotkey</span>
          <HotkeyCaptureField
            value={(hotkeys.primary as Hotkey | null) ?? null}
            onChange={(v) => setPath('hotkeys.primary', v)}
          />
          <span className="block text-xs text-zinc-500">
            Hold = dictation; double-tap = start meeting; single-tap = stop meeting.
            Supports modifier-only (e.g., right ⌥) or modifier + key (e.g., ⌘⇧D).
            Setting a hotkey here disables the Fn (Globe) key.
          </span>
        </div>
      </Section>

      <Section title="Advanced">
        <NumberField
          label="VAD silence threshold (dBFS)"
          min={-80}
          max={-20}
          step={1}
          value={Number(advanced.vadSilenceThresholdDbfs ?? -50)}
          onChange={(v) => setPath('advanced.vadSilenceThresholdDbfs', v)}
          hint="Below this, chunks are skipped (no API call). Default −50 dBFS."
        />
        <GroqKeyField />
      </Section>

      <DangerZone />
    </div>
  );
}

/**
 * Danger zone: deletes every session, chunk, transcript, recording, and stored
 * secret. Settings.json is left alone. Two-step confirmation: a button to
 * arm, then a typed "delete" string to confirm.
 */
function DangerZone() {
  const [armed, setArmed] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wipe = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.electronAPI.data.deleteEverything();
      setDone(true);
      setArmed(false);
      setConfirm('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-red-900/60 bg-red-950/20 p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-red-300">
        Danger zone
      </h2>
      <p className="text-sm text-zinc-300">
        Delete all sessions, transcripts, audio files, and stored secrets. Settings are kept.
      </p>
      {!armed ? (
        <button
          type="button"
          onClick={() => setArmed(true)}
          className="rounded-md border border-red-700 bg-red-900/40 px-3 py-1.5 text-sm text-red-200 hover:bg-red-900/60"
        >
          Delete all data…
        </button>
      ) : (
        <div className="space-y-2">
          <label className="block text-xs text-zinc-400">
            Type <code className="font-mono text-red-300">delete</code> to confirm:
          </label>
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-40 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm"
              placeholder="delete"
            />
            <button
              type="button"
              onClick={() => void wipe()}
              disabled={busy || confirm !== 'delete'}
              className="rounded-md bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-500 disabled:opacity-40"
            >
              {busy ? 'Wiping…' : 'Delete everything'}
            </button>
            <button
              type="button"
              onClick={() => {
                setArmed(false);
                setConfirm('');
              }}
              className="text-xs text-zinc-400 hover:text-zinc-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {done && <p className="text-xs text-emerald-400">Done. Everything deleted.</p>}
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors',
          checked ? 'bg-emerald-600' : 'bg-zinc-700',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform',
            checked && 'translate-x-4',
          )}
        />
      </button>
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  hint?: string;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-32 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm"
      />
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

/**
 * Input device picker. Calls the new `recording_devices.list` IPC on mount
 * and surfaces a select with "System default" + each CoreAudio input
 * device. Selection persists to `settings.recording.inputDeviceId`; the
 * orchestrator re-reads that on every session start, so changes take
 * effect on the next recording without an app restart.
 *
 * The native enumeration may briefly be empty (addon not loaded, no input
 * devices present) — we still render the "System default" row so the user
 * can at least see what's stored.
 */
function InputDeviceField({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  type DeviceKind = 'built_in' | 'bluetooth' | 'usb' | 'other';
  type DeviceInfo = {
    id: string;
    name: string;
    isDefault: boolean;
    kind: DeviceKind;
  };
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await window.electronAPI.recording_devices.list();
      setDevices(r.devices as DeviceInfo[]);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  // Bucket the devices for the optgroup layout. Built-in stays its own
  // group (usually one entry — the Mac's mic); everything else goes under
  // "Other devices" since the user mostly cares about "built-in vs not"
  // when picking.
  const builtIn = devices.filter((d) => d.kind === 'built_in');
  const other = devices.filter((d) => d.kind !== 'built_in');

  // If the saved deviceId is no longer in the device list (unplugged since
  // last session), still show it as "Unavailable — <id>" so the user knows
  // why their input behavior changed.
  const knownIds = new Set(devices.map((d) => d.id));
  const showOrphan = value !== null && !knownIds.has(value);

  return (
    <label className="block space-y-1">
      <span className="text-sm">Input device</span>
      <div className="flex items-center gap-2">
        <select
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
          className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm"
        >
          <option value="">Auto-detect (system default)</option>
          {builtIn.length > 0 && (
            <optgroup label="Built-in">
              {builtIn.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.isDefault ? ' (current default)' : ''}
                </option>
              ))}
            </optgroup>
          )}
          {other.length > 0 && (
            <optgroup label="Other devices">
              {other.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.isDefault ? ' (current default)' : ''}
                </option>
              ))}
            </optgroup>
          )}
          {showOrphan && (
            <option key={value ?? ''} value={value ?? ''}>
              Unavailable — {value}
            </option>
          )}
        </select>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
        >
          {loading ? '…' : 'Refresh'}
        </button>
      </div>
      <span className="block text-xs text-zinc-500">
        Auto-detect follows whatever your Mac considers the current default —
        TwinMind switches with it during a recording (e.g. when you connect
        AirPods). Pick a specific device to pin it; TwinMind won't switch
        away even if you change the default mid-recording.
      </span>
    </label>
  );
}

/**
 * Groq key field — write-only. The cleartext is encrypted by main via
 * DarwinSecureStorage and persisted in JobStore.kv. The renderer never reads
 * it back; we only ask whether one is set (via settings.hasSecret).
 */
function GroqKeyField() {
  const [present, setPresent] = useState<boolean | null>(null);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.electronAPI.settings
      .hasSecret({ name: 'groq_api_key' })
      .then((r) => setPresent(r.present))
      .catch(() => setPresent(null));
  }, []);

  const save = async (next: string) => {
    setSaving(true);
    setError(null);
    try {
      await window.electronAPI.settings.setSecret({ name: 'groq_api_key', value: next });
      setPresent(next.length > 0);
      setValue('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-1">
      <span className="text-sm">Groq API key</span>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={value}
          placeholder={present ? 'Stored — paste new key to replace' : 'paste sk-…'}
          onChange={(e) => setValue(e.target.value)}
          className="w-64 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm placeholder:text-zinc-600"
        />
        <button
          type="button"
          onClick={() => void save(value)}
          disabled={saving || value.length === 0}
          className="rounded-md bg-emerald-600 px-3 py-1 text-xs text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {present && (
          <button
            type="button"
            onClick={() => void save('')}
            disabled={saving}
            className="text-xs text-zinc-400 hover:text-zinc-200"
          >
            Clear
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <p className="text-xs text-zinc-500">
        Encrypted on disk via the macOS Keychain. The renderer can't read it back.
      </p>
    </div>
  );
}
