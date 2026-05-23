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
    await save(next as Parameters<typeof save>[0]);
  };

  const recording = (draft.recording ?? {}) as Record<string, unknown>;
  const meeting = (draft.meetingDetection ?? {}) as Record<string, unknown>;
  const hotkeys = (draft.hotkeys ?? {}) as Record<string, unknown>;

  return (
    <div className="space-y-6">
      <Section title="Account">
        <AccountCard />
      </Section>

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
            Hold = press-to-talk dictation; double-tap = hands-free dictation
            (single-tap to stop). The hotkey is dictation-only — meetings are
            started and stopped from the floating button. Supports modifier-only
            (e.g., right ⌥) or modifier + key (e.g., ⌘⇧D). Setting a non-Fn
            hotkey here disables the Fn (Globe) key as a built-in dictation
            shortcut.
          </span>
        </div>
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

  // First built-in mic (usually only one) — used to label the "auto"
  // option meaningfully. When the user has no pinned device, the runtime
  // resolver in main resolves to this mic's id at session start.
  const builtInDefault = builtIn[0] ?? null;
  const autoOptionLabel = builtInDefault
    ? `${builtInDefault.name} (recommended)`
    : 'Auto-detect (system default)';

  return (
    <label className="block space-y-1">
      <span className="text-sm">Input device</span>
      <div className="flex items-center gap-2">
        <select
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
          // Fixed width + truncate keeps the closed dropdown from auto-resizing
          // to fit the current selection (short names shrink it, long names
          // overflow the row). Chromium honors `truncate` on the closed <select>
          // so long device names render with `…`. The OPEN dropdown list is
          // rendered by the native widget — CSS doesn't apply there, so it
          // shows full names; acceptable trade-off for not building a custom
          // dropdown.
          className="w-72 truncate rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm"
        >
          <option value="">{autoOptionLabel}</option>
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
        The recommended option uses your Mac's built-in microphone. Pick a
        specific device to pin it — TwinMind won't switch away even if you
        change the OS default mid-recording.
      </span>
    </label>
  );
}

/**
 * AccountCard — shows the signed-in user + a Sign-out button.
 *
 * The auth state arrives via the AUTH_STATE_CHANGED push so this card stays
 * fresh as tokens rotate. On sign-out, main.ts tears down the per-user
 * ComposedApp; the renderer's App.tsx receives the push and routes to
 * SignInScreen, so this component never has to render an "I just signed
 * out" state — it gets unmounted with the SettingsPage.
 */
function AccountCard() {
  const [user, setUser] = useState<{
    id: string;
    email: string;
    name: string | null;
    photoUrl: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Shown when main refuses sign-out because a recording is active. Closes
   * on backdrop click; re-opens automatically the next time the user clicks
   * Sign out while still recording, so there's no race-condition where a
   * fast clicker dismisses-and-presses past the guard.
   */
  const [showRecordingBlock, setShowRecordingBlock] = useState(false);

  useEffect(() => {
    void window.electronAPI.auth.getState().then((s) => setUser(s.user));
    const unsub = window.electronAPI.on.authStateChanged((s) => setUser(s.user));
    return () => unsub();
  }, []);

  if (!user) {
    // Settings is only reachable when authed, but renders during sign-out
    // race — fall back gracefully rather than crashing.
    return <p className="text-sm text-zinc-500">Not signed in.</p>;
  }

  const handleSignOut = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await window.electronAPI.auth.signOut();
      if (!r.ok && r.error === 'recording_active') {
        setShowRecordingBlock(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-4 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        {user.photoUrl ? (
          <img
            src={user.photoUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="h-12 w-12 rounded-full border border-zinc-800 object-cover"
          />
        ) : (
          <div className="flex h-12 w-12 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-sm text-zinc-400">
            {(user.email[0] ?? '?').toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-zinc-100">
            {user.name ?? user.email}
          </div>
          {user.name ? (
            <div className="truncate text-xs text-zinc-500">{user.email}</div>
          ) : null}
          {error ? <div className="mt-1 text-xs text-red-400">{error}</div> : null}
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          disabled={busy}
          className="rounded-md border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
        >
          {busy ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
      {showRecordingBlock ? (
        <RecordingActiveModal onClose={() => setShowRecordingBlock(false)} />
      ) : null}
    </>
  );
}

/**
 * "You can't sign out mid-recording" modal. Backdrop click dismisses;
 * clicking Sign out again while still recording re-fires the IPC and main
 * still refuses → modal pops again. Stopping the recording first then
 * clicking Sign out works.
 */
function RecordingActiveModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="max-w-sm rounded-lg border border-zinc-800 bg-zinc-950 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium text-zinc-100">Recording still in progress</div>
        <div className="mt-2 text-sm text-zinc-400">
          Please stop the recording before signing out.
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
