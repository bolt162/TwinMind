/**
 * HomePage — the default landing tab.
 *
 * Replaced the old RecordingDashboard's manual start/stop buttons. Two
 * entry points to recording, each tied to its own affordance:
 *   - Dictation: the configurable hotkey (hold-to-talk + double-tap-for-
 *     hands-free).
 *   - Meeting: the HUD's "Capture notes" button — the only meeting entry
 *     point (the hotkey is dictation-only).
 *
 * This page just orients the user with a time-of-day greeting, the two
 * instruction lists, and a focusable text area they can use to test
 * auto-paste.
 *
 * Layout is sized to fit a typical-height window without scrolling: a soft
 * greeting up top, the dictation steps + a compact "Try it" textarea, then
 * the meeting steps. The textarea is intentionally short (3 rows) so the
 * whole page lands above the fold; user can drag the resize handle if they
 * dictate something longer.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Sparkles } from 'lucide-react';
import { formatHotkey, type Hotkey } from '@core/hotkey/HotkeyTypes';

export function HomePage() {
  const greeting = useMemo(() => greetingForHour(new Date().getHours()), []);
  const hotkeyLabel = useHotkeyLabel();

  return (
    <section className="mx-auto flex h-full max-w-2xl flex-col gap-6 py-2">
      <UpdateBanner />
      <header>
        <h1 className="font-serif text-4xl font-light tracking-tight text-zinc-50">
          {greeting}
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Here's how to use TwinMind. The floating microphone stays put across all spaces.
        </p>
      </header>

      <InstructionList
        title="Dictation"
        steps={[
          <>
            Press and hold <Kbd testId="home-hotkey-label">{hotkeyLabel}</Kbd>
          </>,
          <>Speak, then release to auto-paste the transcription where your cursor is</>,
          <>
            For hands-free dictation, double-tap <Kbd>{hotkeyLabel}</Kbd> to start; single-tap{' '}
            <Kbd>{hotkeyLabel}</Kbd> to stop
          </>,
        ]}
      />

      <TestField />

      <InstructionList
        title="Meeting"
        steps={[
          <>
            Hover the floating microphone, then click the{' '}
            <InlineHudButton>
              <InlineCaptureNotesBars />
              <span className="text-[10px] font-medium tracking-wide text-white">
                Capture Notes
              </span>
            </InlineHudButton>{' '}
            button to start
          </>,
          <>Click it again to stop</>,
        ]}
      />

      <p className="mt-auto text-xs text-zinc-500">
        To change the hotkey, go to Settings → Hotkey.
      </p>
    </section>
  );
}

/** A section title with star-bulleted steps. */
function InstructionList({
  title,
  steps,
}: {
  title: string;
  steps: ReadonlyArray<React.ReactNode>;
}) {
  return (
    <div>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
        {title}
      </h2>
      <ul className="space-y-1.5">
        {steps.map((step, i) => (
          <li key={i} className="flex items-start gap-2 text-sm leading-relaxed text-zinc-200">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
            <span>{step}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Empty textarea the user can focus to test dictation-paste. The OS paste
 * service drops transcribed text into whatever has cursor focus at release
 * time, so clicking inside this field then doing a dictation lands the
 * result here. Has no save/persist — pure scratch space.
 */
function TestField() {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [value, setValue] = useState('');

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Try it
        </h2>
        {value.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setValue('');
              ref.current?.focus();
            }}
            className="text-xs text-zinc-500 hover:text-zinc-200"
          >
            Clear
          </button>
        )}
      </div>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Click here, then hold your hotkey to dictate. The transcription will paste in."
        rows={3}
        className="w-full resize-y rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
      />
    </div>
  );
}

/**
 * Live-refreshing hotkey label. Subscribes to HOTKEY_CHANGED so the steps
 * reflect a fresh capture without a reload. Falls back to "🌐 Fn" when
 * nothing's configured — Globe is the always-on default.
 */
function useHotkeyLabel(): string {
  const [label, setLabel] = useState<string>('🌐 Fn');
  useEffect(() => {
    const apply = (primary: Hotkey | null) => {
      setLabel(primary ? formatHotkey(primary) : '🌐 Fn');
    };
    void window.electronAPI.settings
      .get()
      .then((s) => {
        const primary = (s as { hotkeys?: { primary?: Hotkey | null } }).hotkeys?.primary;
        apply(primary ?? null);
      })
      .catch(() => {});
    const unsub = window.electronAPI.on.hotkeyChanged((e) => {
      apply((e.primary as Hotkey | null) ?? null);
    });
    return () => unsub();
  }, []);
  return label;
}

function greetingForHour(h: number): string {
  if (h < 5) return 'Working late?';
  if (h < 12) return 'Good morning,';
  if (h < 17) return 'Good afternoon,';
  if (h < 22) return 'Good evening,';
  return 'Good night,';
}

function Kbd({ children, testId }: { children: string; testId?: string }) {
  return (
    <kbd
      data-testid={testId}
      className="mx-0.5 inline-flex items-center rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono text-[11px] text-zinc-200"
    >
      {children}
    </kbd>
  );
}

/**
 * Mini visual of the HUD's "Capture Notes" pill — matches the actual labelled
 * button (icon + "Capture Notes" text) so the user can recognize it in the
 * HUD when reading the meeting instructions. Smaller scale (h-5, body
 * font shrunk to 10 px) since it sits inline with body text.
 */
function InlineHudButton({ children }: { children: React.ReactNode }) {
  return (
    <span className="mx-0.5 inline-flex h-5 items-center justify-center gap-1 rounded-full border border-white/40 bg-black/55 px-1.5 align-middle">
      {children}
    </span>
  );
}

/**
 * Inline mini version of the HUD's three-bar CaptureNotesBars icon —
 * scaled down to sit inside InlineHudButton's 20 px row. Same short-tall-
 * short proportions as the HUD copy.
 */
function InlineCaptureNotesBars() {
  // Centered equalizer geometry — matches HudApp's CaptureNotesBars
  // (`| | |` with the middle bar tallest above AND below) so the inline
  // instruction visual mirrors the real HUD button exactly.
  return (
    <span
      className="inline-flex h-3 w-3 shrink-0 items-center justify-center gap-[1px] text-white"
      aria-hidden
    >
      <span className="block w-[1.5px] rounded-full bg-current" style={{ height: 6 }} />
      <span className="block w-[1.5px] rounded-full bg-current" style={{ height: 11 }} />
      <span className="block w-[1.5px] rounded-full bg-current" style={{ height: 6 }} />
    </span>
  );
}

/**
 * UpdateBanner — only renders when a downloaded update is sitting `ready`.
 *
 * Recording-active state: the Restart & Update button is replaced with a
 * disabled "Finish your recording first" affordance. The main-side
 * UpdateService also refuses the install in that case — both gates exist so
 * a user clicking the button between renderer state-sync and orchestrator
 * state-read doesn't slip through.
 *
 * Spec §6: "If the YAML's version equals the running app's version… no
 * banner, no download." The banner is gated on phase === 'ready' which only
 * happens after a real download finished, so this is implicit.
 */
function UpdateBanner() {
  type State = Awaited<ReturnType<typeof window.electronAPI.update.getState>>;
  const [state, setState] = useState<State | null>(null);
  const [recordingActive, setRecordingActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.electronAPI.update.getState().then((s) => {
      if (alive) setState(s);
    });
    const offUpdate = window.electronAPI.on.updateStateChanged((s) => {
      if (alive) setState(s);
    });
    const offRec = window.electronAPI.on.recordingStateChanged((e) => {
      if (!alive) return;
      // `recording` / `starting` / `stopping` all count — anything mid-flight
      // where killing the process would orphan an in-progress chunk.
      setRecordingActive(
        e.state === 'recording' || e.state === 'starting' || e.state === 'stopping',
      );
    });
    return () => {
      alive = false;
      offUpdate();
      offRec();
    };
  }, []);

  if (!state || state.phase !== 'ready') return null;

  const onInstall = async () => {
    setSubmitting(true);
    try {
      // If main refuses with recording_active (race between renderer state
      // and orchestrator state), the response carries the typed error and
      // the banner stays put. The recording-state listener will flip the
      // banner copy back to the "finish recording first" form within
      // milliseconds anyway.
      const r = await window.electronAPI.update.quitAndInstall();
      if (!r.ok && r.error === 'recording_active') {
        setRecordingActive(true);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-testid="update-banner"
      data-update-version={state.version ?? ''}
      className="flex items-center gap-3 rounded-lg border border-emerald-700/60 bg-emerald-950/40 px-4 py-2.5"
    >
      <Download className="h-4 w-4 shrink-0 text-emerald-400" />
      <div className="flex-1 text-sm">
        {recordingActive ? (
          <span className="text-zinc-200">
            Update ready — finish your recording first.
          </span>
        ) : (
          <span className="text-zinc-200">
            TwinMind {state.version} is ready to install.
          </span>
        )}
      </div>
      <button
        type="button"
        data-testid="update-install-button"
        onClick={() => void onInstall()}
        disabled={recordingActive || submitting}
        className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
        title={recordingActive ? 'Stop your recording, then click to install.' : undefined}
      >
        {submitting ? 'Restarting…' : 'Restart & Update'}
      </button>
    </div>
  );
}
