/**
 * HomePage — the default landing tab.
 *
 * Replaced the old RecordingDashboard's manual start/stop buttons. Two
 * entry points to recording, each tied to its own affordance:
 *   - Dictation: the configurable hotkey (hold-to-talk + double-tap-for-
 *     hands-free).
 *   - Meeting: the HUD's "Take notes" button — the only meeting entry
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
import { Radio, Sparkles } from 'lucide-react';
import { formatHotkey, type Hotkey } from '@core/hotkey/HotkeyTypes';

export function HomePage() {
  const greeting = useMemo(() => greetingForHour(new Date().getHours()), []);
  const hotkeyLabel = useHotkeyLabel();

  return (
    <section className="mx-auto flex h-full max-w-2xl flex-col gap-6 py-2">
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
            Press and hold <Kbd>{hotkeyLabel}</Kbd>
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
              <Radio className="h-3 w-3 text-white" />
              <span className="text-[10px] font-medium tracking-wide text-white">
                Take notes
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

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="mx-0.5 inline-flex items-center rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono text-[11px] text-zinc-200">
      {children}
    </kbd>
  );
}

/**
 * Mini visual of the HUD's "Take notes" pill — matches the actual labelled
 * button (icon + "Take notes" text) so the user can recognize it in the
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
