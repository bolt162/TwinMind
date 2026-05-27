/**
 * OnboardingFlow — multi-step PERMISSIONS wizard.
 *
 * Steps: welcome → mic → audio capture → accessibility → notifications → done.
 * Sign-in is NOT part of onboarding — it gates the entire app at SignInScreen.
 * Signing out returns the user to SignInScreen but does NOT rewind the wizard
 * (permissions are macOS-scoped, so the wizard's gate is too).
 *
 * The final step calls `onComplete` which fires the WIZARD_COMPLETE IPC, which
 * writes the machine-scoped completion marker into GlobalDb.wizard.
 */

import { useEffect, useState } from 'react';
import { Check, ChevronRight, Mic, Radio, Accessibility, Bell } from 'lucide-react';
import type { Settings } from '../hooks/useSettings';
import { cn } from '../components/cn';
import { formatHotkey, type Hotkey } from '@core/hotkey/HotkeyTypes';

type Step =
  | 'welcome'
  | 'mic'
  | 'audioCapture'
  | 'accessibility'
  | 'notifications'
  | 'done';

interface OnboardingFlowProps {
  readonly onComplete: () => Promise<void> | void;
}

export function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const [step, setStep] = useState<Step>('welcome');

  const advance = (next: Step) => setStep(next);

  return (
    <div
      data-testid="onboarding-flow"
      data-onboarding-step={step}
      className="flex min-h-screen items-center justify-center bg-zinc-950 p-8 text-zinc-100"
    >
      <div className="w-full max-w-xl rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 shadow-2xl">
        {step === 'welcome' && <WelcomeStep onNext={() => advance('mic')} />}
        {step === 'mic' && <MicStep onNext={() => advance('audioCapture')} />}
        {step === 'audioCapture' && <AudioCaptureStep onNext={() => advance('accessibility')} />}
        {step === 'accessibility' && <AccessibilityStep onNext={() => advance('notifications')} />}
        {step === 'notifications' && <NotificationsStep onNext={() => advance('done')} />}
        {step === 'done' && <DoneStep onComplete={onComplete} />}
      </div>
    </div>
  );
}

function StepHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold tracking-tight text-zinc-50">{title}</h1>
      <p className="mt-1 text-sm text-zinc-400">{subtitle}</p>
    </div>
  );
}

function PrimaryButton({
  onClick,
  children,
  disabled,
  testId,
}: {
  onClick: () => void | Promise<void>;
  children: React.ReactNode;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors',
        'bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40',
      )}
    >
      {children}
    </button>
  );
}

function SecondaryButton({
  onClick,
  children,
  testId,
}: {
  onClick: () => void | Promise<void>;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="text-sm text-zinc-400 hover:text-zinc-200"
    >
      {children}
    </button>
  );
}

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <>
      <StepHeader
        title="Welcome to TwinMind"
        subtitle="Real-time dictation + meeting transcription on your Mac."
      />
      <ul className="mb-6 space-y-2 text-sm text-zinc-300">
        <li className="flex items-center gap-2">
          <Check className="h-4 w-4 text-emerald-500" /> Audio never leaves your machine without
          consent.
        </li>
        <li className="flex items-center gap-2">
          <Check className="h-4 w-4 text-emerald-500" /> Everything works offline; transcripts
          upload when you're back online.
        </li>
        <li className="flex items-center gap-2">
          <Check className="h-4 w-4 text-emerald-500" /> A floating mic button stays accessible
          across all Spaces.
        </li>
      </ul>
      <PrimaryButton testId="onboarding-welcome-next" onClick={onNext}>
        Get started <ChevronRight className="h-4 w-4" />
      </PrimaryButton>
    </>
  );
}

function MicStep({ onNext }: { onNext: () => void }) {
  // Tri-state grant — `denied` and `not_determined` need different click
  // behavior (see `request` below), so a boolean wouldn't be expressive
  // enough. `unavailable` is collapsed into `denied` since the user-facing
  // remediation is the same (flip the toggle in System Settings).
  type GrantState = 'granted' | 'denied' | 'not_determined';
  const [grant, setGrant] = useState<GrantState>('not_determined');
  const [requesting, setRequesting] = useState(false);

  // Read the OS grant on mount AND poll every 1s while the step is mounted.
  // The poll covers the denied → grant path: when the user clicks Grant
  // while denied, we open System Settings → Privacy → Microphone; the user
  // flips the toggle and returns to TwinMind. The poll catches the flip and
  // updates the UI to "Granted ✓" + "Continue" without re-clicking.
  // (Same pattern as AccessibilityStep below.)
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await window.electronAPI.permissions.read({ kind: 'mic' });
        if (cancelled) return;
        if (r.grant === 'granted') setGrant('granted');
        else if (r.grant === 'not_determined') setGrant('not_determined');
        else setGrant('denied'); // 'denied' | 'unavailable'
      } catch {
        /* ignore transient IPC errors */
      }
    };
    void tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Branch on the current grant state:
  //   not_determined → askForMediaAccess shows the OS prompt; we set the
  //                    new grant from its boolean return.
  //   denied         → askForMediaAccess silently returns false WITHOUT a
  //                    prompt (macOS rule once the user has chosen deny),
  //                    which is why the old single-path Grant button
  //                    appeared to do nothing. Open Privacy → Microphone
  //                    so the user has a one-click path to fix it; the
  //                    1s poll above will see the flip and reach 'granted'.
  //   granted        → no-op (button is hidden in this state).
  const request = async () => {
    setRequesting(true);
    try {
      if (grant === 'denied') {
        await window.electronAPI.permissions.openSystemSettings({ kind: 'mic' });
        return;
      }
      const r = await window.electronAPI.permissions.requestMic();
      setGrant(r.granted ? 'granted' : 'denied');
    } finally {
      setRequesting(false);
    }
  };
  return (
    <>
      <StepHeader
        title="Microphone access"
        subtitle="Required to record your voice. You'll see the macOS prompt."
      />
      <div className="mb-6 flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <Mic className="h-6 w-6 text-zinc-300" />
        <div className="text-sm text-zinc-300">
          {grant === 'granted' && <span className="text-emerald-400">Granted ✓</span>}
          {grant === 'denied' && (
            <span className="text-amber-400">
              Denied. Click Grant to open System Settings → Privacy → Microphone.
            </span>
          )}
          {grant === 'not_determined' && 'Click below to request.'}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {grant !== 'granted' && (
          <PrimaryButton testId="onboarding-mic-grant" onClick={request} disabled={requesting}>
            {requesting ? (grant === 'denied' ? 'Opening…' : 'Requesting…') : 'Grant'}
          </PrimaryButton>
        )}
        <SecondaryButton testId="onboarding-mic-next" onClick={onNext}>{grant === 'granted' ? 'Continue' : 'Skip for now'}</SecondaryButton>
      </div>
    </>
  );
}

// System-audio capture is introspected via TCC.framework's TCCAccessPreflight
// (wired through the native addon) — we poll it the same way AccessibilityStep
// polls Accessibility. Notifications still has no introspection API, so we
// keep the localStorage hint for that one only.
const NOTIFICATIONS_REQUESTED_KEY = 'twinmind.permissions.notificationsRequested';

function readLocalFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

function writeLocalFlag(key: string, value: boolean): void {
  try {
    if (value) localStorage.setItem(key, 'true');
    else localStorage.removeItem(key);
  } catch {
    /* private mode or quota — fine, just no persistence */
  }
}

function AudioCaptureStep({ onNext }: { onNext: () => void }) {
  // Three states: 'granted' / 'denied' / 'not_determined'. We poll the TCC
  // database every 1s while mounted — same cadence as AccessibilityStep — so
  // an out-of-app grant or revoke (e.g., user flipping the toggle in System
  // Settings) is reflected here within a second.
  type Grant = 'granted' | 'denied' | 'not_determined';
  const [grant, setGrant] = useState<Grant>('not_determined');
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await window.electronAPI.permissions.read({ kind: 'audioCapture' });
        if (!cancelled) {
          const g = r.grant === 'granted' ? 'granted' : r.grant === 'denied' ? 'denied' : 'not_determined';
          setGrant(g);
        }
      } catch {
        /* ignore transient IPC errors */
      }
    };
    void tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const request = async () => {
    setRequesting(true);
    try {
      // 'not_determined' → fire the OS prompt. 'denied' → deep-link to the
      // Privacy pane so the user has a one-click path to the toggle.
      if (grant === 'not_determined') {
        const r = await window.electronAPI.permissions.requestAudioCapture();
        setGrant(r.granted ? 'granted' : 'denied');
      } else {
        await window.electronAPI.permissions.openSystemSettings({ kind: 'audioCapture' });
      }
    } finally {
      setRequesting(false);
    }
  };

  return (
    <>
      <StepHeader
        title="Audio capture (meeting mode)"
        subtitle="Lets TwinMind hear the other side of a Zoom/Meet call. Skippable — meetings will just be mic-only without it."
      />
      <div className="mb-6 flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <Radio className="h-6 w-6 text-zinc-300" />
        <div className="text-sm text-zinc-300">
          {grant === 'granted' && <span className="text-emerald-400">Granted ✓</span>}
          {grant === 'denied' && (
            <span className="text-amber-400">
              Not granted. Click Open settings to flip the toggle in Privacy &amp; Security → Audio Capture.
            </span>
          )}
          {grant === 'not_determined' && 'Click Grant — macOS will show its "Audio Capture" prompt.'}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {grant !== 'granted' && (
          <PrimaryButton testId="onboarding-audiocap-grant" onClick={request} disabled={requesting}>
            {requesting
              ? grant === 'denied'
                ? 'Opening…'
                : 'Requesting…'
              : grant === 'denied'
                ? 'Open settings'
                : 'Grant'}
          </PrimaryButton>
        )}
        <SecondaryButton testId="onboarding-audiocap-next" onClick={onNext}>
          {grant === 'granted' ? 'Continue' : 'Skip for now'}
        </SecondaryButton>
      </div>
    </>
  );
}

function AccessibilityStep({ onNext }: { onNext: () => void }) {
  const [granted, setGranted] = useState<boolean | null>(null);
  const [requesting, setRequesting] = useState(false);

  // Poll the current Accessibility grant while the step is mounted. The user
  // flips the toggle in System Settings — we mirror it back as a green check
  // here so they know they're done.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await window.electronAPI.permissions.read({ kind: 'accessibility' });
        if (!cancelled) setGranted(r.grant === 'granted');
      } catch {
        /* ignore transient IPC errors */
      }
    };
    void tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const request = async () => {
    setRequesting(true);
    try {
      // Surfaces the prompt + registers TwinMind in the TCC list AND opens
      // the Accessibility pane. The user just flips the toggle from there.
      await window.electronAPI.permissions.requestAccessibility();
    } finally {
      setRequesting(false);
    }
  };

  return (
    <>
      <StepHeader
        title="Accessibility (dictation paste + hotkey)"
        subtitle="Required so TwinMind can paste dictated text and listen for global hotkeys. Without it, you'll have to press Cmd-V manually and the hotkey won't work."
      />
      <div className="mb-6 flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <Accessibility className="h-6 w-6 text-zinc-300" />
        <div className="text-sm text-zinc-300">
          {granted === true ? (
            <span className="text-emerald-400">Granted ✓</span>
          ) : (
            <>
              Click Grant, then flip the toggle next to TwinMind in{' '}
              <span className="font-mono">Privacy &amp; Security → Accessibility</span>.
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {granted !== true && (
          <PrimaryButton testId="onboarding-accessibility-grant" onClick={request} disabled={requesting}>
            {requesting ? 'Opening…' : 'Grant'}
          </PrimaryButton>
        )}
        <SecondaryButton testId="onboarding-accessibility-next" onClick={onNext}>{granted === true ? 'Continue' : 'Skip for now'}</SecondaryButton>
      </div>
    </>
  );
}

function NotificationsStep({ onNext }: { onNext: () => void }) {
  const [granted, setGranted] = useState<boolean | null>(() =>
    readLocalFlag(NOTIFICATIONS_REQUESTED_KEY) ? true : null,
  );
  const [requesting, setRequesting] = useState(false);
  const request = async () => {
    setRequesting(true);
    try {
      const r = await window.electronAPI.permissions.requestNotifications();
      setGranted(r.granted);
      if (r.granted) writeLocalFlag(NOTIFICATIONS_REQUESTED_KEY, true);
    } finally {
      setRequesting(false);
    }
  };
  return (
    <>
      <StepHeader
        title="Notifications"
        subtitle="Used for the meeting auto-detect prompt. You can always disable detection in Settings."
      />
      <div className="mb-6 flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <Bell className="h-6 w-6 text-zinc-300" />
        <div className="text-sm text-zinc-300">
          {granted === true ? (
            <span className="text-emerald-400">Granted ✓</span>
          ) : (
            'Click Allow — macOS will show its notifications prompt.'
          )}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {granted !== true && (
          <PrimaryButton testId="onboarding-notifications-grant" onClick={request} disabled={requesting}>
            {requesting ? 'Requesting…' : 'Allow'}
          </PrimaryButton>
        )}
        <SecondaryButton testId="onboarding-notifications-next" onClick={onNext}>{granted === true ? 'Continue' : 'Skip for now'}</SecondaryButton>
      </div>
    </>
  );
}

function DoneStep({ onComplete }: { onComplete: () => Promise<void> | void }) {
  // Pull the configured hotkey just for the friendly label. Optional — if
  // settings haven't loaded yet (race) we fall back to "Fn".
  const [primary, setPrimary] = useState<Hotkey | null>(null);
  useEffect(() => {
    void window.electronAPI.settings
      .get()
      .then((s) => {
        const h = (s as { hotkeys?: { primary?: Hotkey | null } }).hotkeys?.primary ?? null;
        setPrimary(h);
      })
      .catch(() => {
        /* not signed in or transient; the default label is fine */
      });
  }, []);
  const hotkeyLabel = primary ? formatHotkey(primary) : 'Fn';
  return (
    <>
      <StepHeader
        title="You're set"
        subtitle={`Hold ${hotkeyLabel} to dictate. The floating mic pill at the bottom of your screen has the rest of the controls.`}
      />
      <PrimaryButton testId="onboarding-done-button" onClick={onComplete}>Open TwinMind</PrimaryButton>
    </>
  );
}
