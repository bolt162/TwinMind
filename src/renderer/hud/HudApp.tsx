/**
 * HudApp — Wispr-style floating pill.
 *
 * UI priority (highest first):
 *   recording  → live amplitude waveform (real audio RMS)
 *   processing → queue is working (initial upload OR retry): radial spinner
 *   failed     → expanded error banner with Retry + History buttons
 *   idle       → small dot (or "Dictate" label + hotkey chip when hovered)
 *
 * The recording state takes visual priority — if a fresh recording starts
 * while previous chunks are stuck in `failed_permanent`, the HUD shows the
 * waveform; on stop, it falls back to the failed banner.
 *
 * Drag and hover behaviour, plus the click-vs-drag heuristic, are unchanged
 * from the previous revision.
 */

import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Radio, RotateCw, History, X, Home } from 'lucide-react';
import { formatHotkey, type Hotkey } from '@core/hotkey/HotkeyTypes';

type RecordingState = 'idle' | 'starting' | 'recording' | 'stopping';
type RecordingMode = 'idle' | 'dictation' | 'meeting';
type TranscriptionUiState =
  | { kind: 'idle' }
  | { kind: 'processing' }
  | { kind: 'failed'; sessionId: string };

const BAR_COUNT = 20;
const DECAY = 0.86;
const PILL_HEIGHT_EXPANDED = 32;
const PILL_HEIGHT_IDLE = 22;
const PILL_HEIGHT_FAILED = 100;
const BAR_MAX_HEIGHT_PX = 24;
const BAR_MIN_HEIGHT_PX = 2;
const AMP_GAIN = 2.4;
const DRAG_THRESHOLD_PX = 3;

// Loader: 12 thin bars arranged radially around a center; each bar fades
// from full opacity → near-transparent on a staggered loop, producing the
// classic spinner effect. Period chosen to feel "working" without being
// frenetic; ~12 bars matches the macOS native spinner cadence.
const LOADER_BAR_COUNT = 12;
const LOADER_PERIOD_S = 1.0;

/** State for the device-loss pause/resume affordance. Set when main pushes
 *  MIC_DEVICE_LOST; cleared on successful Resume or user Stop. */
interface DeviceLostState {
  readonly sessionId: string;
  readonly mode: 'dictation' | 'meeting';
  readonly lastDeviceLabel: string | null;
  readonly devices: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly isDefault: boolean;
    readonly kind: 'built_in' | 'bluetooth' | 'usb' | 'other';
  }>;
}

export function HudApp() {
  const [recording, setRecording] = useState<RecordingState>('idle');
  // Mode is read from the same RECORDING_STATE_CHANGED push. We need it to
  // route clicks: the main pill drives dictation, the meeting button drives
  // meeting mode, and each one is disabled while the OTHER mode is recording.
  const [mode, setMode] = useState<RecordingMode>('idle');
  const [txState, setTxState] = useState<TranscriptionUiState>({ kind: 'idle' });
  const [hovered, setHovered] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [deviceLost, setDeviceLost] = useState<DeviceLostState | null>(null);
  // Configured hotkey, shown as a chip inside the hover-idle pill. Globe
  // (Fn) is the always-on default; settings.hotkeys.primary is the optional
  // extra. We display the primary if set, otherwise "Fn".
  const [hotkeyLabel, setHotkeyLabel] = useState<string>('Fn');
  // Live session id, captured from startMeeting + recording_state_changed
  // pushes so the HUD can stop sessions started via hotkey/auto-detect too.
  const sessionIdRef = useRef<string | null>(null);

  // Debounced hover-off so moving the cursor from the main pill across the
  // gap to the Home button doesn't flicker the Home button out. The HUD
  // window is transparent: the gap between buttons is not a rendered
  // element, so neither element fires mouseenter while the cursor is in
  // transit — without this debounce, the Home button would disappear
  // mid-traversal.
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setGroupHovered = (next: boolean) => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    if (next) {
      setHovered(true);
    } else {
      hoverTimeoutRef.current = setTimeout(() => setHovered(false), 180);
    }
  };
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  // Click-through plumbing. The HUD window defaults to click-through; we
  // disable it only when the cursor is over an interactive element. We use
  // a hit-test on every mousemove (rather than per-element mouseenter/leave)
  // because Chrome/Electron doesn't always fire mouseleave when a shrinking
  // element passes under a stationary cursor — so right after a recording
  // ends and the pill shrinks back to idle, the old approach left ignore
  // stuck at false, blocking click-through for the empty area again.
  //
  // We also re-check after every visual state change (pill grows/shrinks
  // without cursor motion), and force ignore=false for the duration of a
  // drag so wandering off the pill mid-drag doesn't break it.
  const dragActiveRef = useRef(false);
  const lastCursorRef = useRef<{ x: number; y: number } | null>(null);
  const currentIgnoreRef = useRef<boolean>(true);

  const applyIgnore = (next: boolean) => {
    if (dragActiveRef.current && next) return;
    if (currentIgnoreRef.current === next) return;
    currentIgnoreRef.current = next;
    void window.electronAPI.hud.setMouseIgnore({ ignore: next }).catch(() => {});
  };

  const recheckIgnore = () => {
    if (dragActiveRef.current) return;
    const pos = lastCursorRef.current;
    if (!pos) {
      applyIgnore(true);
      return;
    }
    const el = document.elementFromPoint(pos.x, pos.y);
    const interactive = el ? el.closest('[data-hud-interactive="true"]') : null;
    applyIgnore(interactive === null);
  };

  // ─── Subscriptions ──────────────────────────────────────────────────────
  useEffect(() => {
    const unsubRec = window.electronAPI.on.recordingStateChanged((e) => {
      // Mode is part of the push payload; the HUD uses it to decide which
      // affordance owns the recording state (main pill for dictation, the
      // new "Take notes" button for meetings).
      setMode(e.mode);
      if (e.state === 'starting' || e.state === 'recording' || e.state === 'stopping') {
        setRecording(e.state);
        if (e.sessionId) sessionIdRef.current = e.sessionId;
        // Reaching 'recording' means we're past device loss — clear the pill.
        if (e.state === 'recording') setDeviceLost(null);
      } else {
        setRecording('idle');
        sessionIdRef.current = null;
      }
    });
    const unsubLost = window.electronAPI.on.micDeviceLost((e) => {
      setDeviceLost({
        sessionId: e.sessionId,
        mode: e.mode,
        lastDeviceLabel: e.lastDeviceLabel,
        devices: e.devices,
      });
    });
    // Initial read of the configured primary hotkey + live updates via the
    // HOTKEY_CHANGED push channel. Settings live in the per-user DB, so we
    // can only read them once a user is signed in — fetching pre-auth fires
    // SETTINGS_GET against a null composed app and main throws not_signed_in.
    // We gate on AUTH_STATE_CHANGED (with an initial getState()) so the
    // fetch happens after sign-in lands, and re-fires on user switch.
    const applyHotkey = (primary: Hotkey | null) => {
      setHotkeyLabel(primary ? formatHotkey(primary) : 'Fn');
    };
    const refetchHotkey = () => {
      void window.electronAPI.settings
        .get()
        .then((s) => {
          const primary = (s as { hotkeys?: { primary?: Hotkey | null } }).hotkeys?.primary;
          applyHotkey(primary ?? null);
        })
        .catch(() => {
          /* signed out / transient — fall back to the default 'Fn' label */
        });
    };
    void window.electronAPI.auth.getState().then((s) => {
      if (s.isAuthenticated) refetchHotkey();
    });
    const unsubAuth = window.electronAPI.on.authStateChanged((s) => {
      if (s.isAuthenticated) {
        refetchHotkey();
      } else {
        applyHotkey(null);
      }
    });
    const unsubHotkey = window.electronAPI.on.hotkeyChanged((e) => {
      applyHotkey((e.primary as Hotkey | null) ?? null);
    });
    const unsubTx = window.electronAPI.on.transcriptionUiState((e) => {
      setTxState(e);
    });
    return () => {
      unsubRec();
      unsubTx();
      unsubHotkey();
      unsubLost();
      unsubAuth();
    };
  }, []);

  // ─── Amplitude rolling buffer + audio-clock-driven timer ────────────────
  //
  // amplitudeSample carries two things:
  //  - `value`: the RMS bar to plot
  //  - `audioClockMs`: cumulative samples-processed since session start.
  //    We use this as the authoritative recording-elapsed timer. If capture
  //    stalls (Bluetooth HFP renegotiation, device unplug), the clock
  //    freezes alongside the waveform — the user sees something is wrong
  //    instead of being told "60s recorded" when only 53s of audio existed.
  const barsRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const [, force] = useState(0);
  useEffect(() => {
    const unsub = window.electronAPI.on.amplitudeSample((e) => {
      const bars = barsRef.current;
      for (let i = 0; i < BAR_COUNT - 1; i++) bars[i] = bars[i + 1]! * DECAY;
      bars[BAR_COUNT - 1] = e.value;
      setElapsedSec(Math.floor(e.audioClockMs / 1000));
      force((n) => (n + 1) & 0x7fff_ffff);
    });
    return () => unsub();
  }, []);

  // Drain the bar buffer + reset elapsed when leaving recording. We don't
  // need a separate wall-clock timer — `audioClockMs` from the audio
  // process drives elapsedSec while recording.
  useEffect(() => {
    if (recording !== 'recording') {
      setElapsedSec(0);
    }
  }, [recording]);

  // Drain the live waveform when not recording so the next session starts clean.
  useEffect(() => {
    if (recording !== 'recording') {
      barsRef.current.fill(0);
      force((n) => (n + 1) & 0x7fff_ffff);
    }
  }, [recording]);

  // ─── Click-through hit-test ────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      lastCursorRef.current = { x: e.clientX, y: e.clientY };
      recheckIgnore();
    };
    // mouseleave on document fires when the cursor exits the renderer area
    // entirely (off the HUD window). At that point the cursor isn't on any
    // interactive element, so click-through should resume.
    const onLeave = () => {
      lastCursorRef.current = null;
      recheckIgnore();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseleave', onLeave);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', onLeave);
    };
    // recheckIgnore reads refs only; safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Resolve the visual state — recording wins over tx ─────────────────
  const isRecording = recording === 'recording';
  const isBusy = recording === 'starting' || recording === 'stopping';
  type Visual =
    | 'recording'
    | 'processing'
    | 'failed'
    | 'disconnected'
    | 'hoverIdle'
    | 'busy'
    | 'idle';
  // disconnected takes priority — it means an active session is sitting
  // paused with a pinned mic that vanished, waiting for the user to pick a
  // replacement. Surface it over every other state except an active rebind.
  const visual: Visual = deviceLost && !isRecording
    ? 'disconnected'
    : isRecording
      ? 'recording'
      : isBusy
        ? 'busy'
        : txState.kind === 'processing'
          ? 'processing'
          : txState.kind === 'failed'
            ? 'failed'
            : hovered
              ? 'hoverIdle'
              : 'idle';
  const expanded = visual !== 'idle';

  // When the visual changes, the pill's bounds typically change too — but
  // a stationary cursor doesn't fire mousemove from that layout shift, so
  // the hit-test would otherwise stay stale. Re-check after layout settles.
  useEffect(() => {
    const t = setTimeout(recheckIgnore, 0);
    return () => clearTimeout(t);
    // recheckIgnore reads refs only; safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visual, hotkeyLabel]);

  // ─── Drag detection (unchanged from prior revision) ─────────────────────
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const dragMoved = useRef(false);

  const onMouseDown: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    if (e.button !== 0 || isBusy) return;
    dragOrigin.current = { x: e.screenX, y: e.screenY };
    dragMoved.current = false;
    dragActiveRef.current = true;
    void window.electronAPI.hud.beginDrag().catch(() => {});

    const onMove = (ev: MouseEvent) => {
      if (!dragOrigin.current) return;
      const dx = ev.screenX - dragOrigin.current.x;
      const dy = ev.screenY - dragOrigin.current.y;
      if (!dragMoved.current && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD_PX) {
        dragMoved.current = true;
      }
      if (dragMoved.current) {
        void window.electronAPI.hud.dragMoveBy({ dx, dy }).catch(() => {});
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      void window.electronAPI.hud.endDrag().catch(() => {});
      dragOrigin.current = null;
      dragActiveRef.current = false;
      // Drag is over — re-evaluate based on where the cursor actually is
      // now. The guard inside applyIgnore (dragActive=true) had suppressed
      // any ignore=true call during the drag itself.
      recheckIgnore();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // The main pill drives DICTATION only. If a meeting is recording, the
  // pill is non-interactive — the user must stop the meeting first (via
  // the "Take notes" button next to it).
  const pillDisabled = isRecording && mode === 'meeting';

  const onPillClick = () => {
    if (dragMoved.current) {
      dragMoved.current = false;
      return;
    }
    if (isBusy) return;
    if (pillDisabled) return;
    if (recording === 'idle' && txState.kind === 'idle') {
      void window.electronAPI.recording.startDictation().catch(() => {});
    } else if (isRecording && mode === 'dictation') {
      void window.electronAPI.recording.stopDictation().catch(() => {});
    }
    // For 'processing' and 'failed' states, clicks on the pill itself are no-ops
    // — the retry/history buttons inside the pill are what the user touches.
  };

  return (
    <div className="flex h-full w-full items-center justify-center gap-2">
      <button
        type="button"
        onClick={onPillClick}
        onMouseDown={onMouseDown}
        onMouseEnter={() => setGroupHovered(true)}
        onMouseLeave={() => setGroupHovered(false)}
        data-hud-interactive="true"
        aria-label={
          visual === 'recording'
            ? 'Stop dictation'
            : visual === 'failed'
              ? 'Transcription failed; retry or open history'
              : visual === 'processing'
                ? 'Retrying transcription'
                : visual === 'disconnected'
                  ? 'Microphone disconnected; pick a device to resume'
                  : 'Start dictation'
        }
        className={[
          'flex items-center gap-1.5 rounded-full',
          'border border-white/40 bg-black/55 backdrop-blur-md',
          // shadow intentionally removed — the soft halo read as a faint
          // "box" around the buttons on transparent backdrops.
          'transition-[width,height,padding,opacity] duration-150 ease-out',
          'overflow-hidden text-white select-none cursor-grab active:cursor-grabbing',
          // Faded + non-cursor when a meeting is recording. The button stays
          // hit-detectable (so the HUD's hover-reveal still works), but the
          // click handler short-circuits via `pillDisabled` above.
          pillDisabled ? 'opacity-40 cursor-not-allowed' : '',
          visual === 'failed' || visual === 'disconnected'
            ? 'px-6 py-4 items-stretch'
            : expanded
              ? 'px-3'
              : 'px-2',
        ].join(' ')}
        style={{
          // Hover-idle width grows with the hotkey label so long bindings
          // ("Left ⌘ + Right ⇧ + D") aren't clipped while short ones ("Fn",
          // "Right ⌥") stay tight. Other visual states use fixed widths.
          width: visual === 'hoverIdle' ? hoverIdleWidth(hotkeyLabel) : pillWidth(visual),
          height: pillHeight(visual),
        }}
      >
        {visual === 'idle' && (
          <span className="block h-1.5 w-1.5 rounded-full bg-white/70" />
        )}
        {visual === 'hoverIdle' && (
          // Fade the contents in AFTER the pill's 150ms width transition has
          // had time to grow. Without this, the chip/label render at full size
          // immediately while the pill is still narrow, so `overflow-hidden`
          // clips them and they visibly "settle into place" mid-animation.
          // The opacity animation is keyed off the element's mount (React
          // unmounts/remounts when leaving/entering hoverIdle), so it re-fires
          // cleanly on every hover.
          <span
            className="flex flex-1 items-center gap-1.5"
            style={{
              opacity: 0,
              animation: 'hud-hover-content-in 0.15s ease-out 0.15s forwards',
            }}
          >
            <style>{HOVER_CONTENT_KEYFRAMES}</style>
            <Mic className="h-3.5 w-3.5 text-white/85" />
            <span className="text-[11px] font-medium tracking-wide text-white/85">
              Dictate
            </span>
            <span className="ml-auto shrink-0 rounded-md border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white/75">
              {hotkeyLabel}
            </span>
          </span>
        )}
        {visual === 'busy' && (
          <>
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/80" />
            <span className="text-[11px] font-medium text-white/85">…</span>
          </>
        )}
        {visual === 'recording' && (
          <>
            <RecordingDot />
            <Waveform bars={barsRef.current} />
            <span className="shrink-0 text-[11px] font-medium tabular-nums text-white/85">
              {formatElapsed(elapsedSec)}
            </span>
          </>
        )}
        {visual === 'processing' && <LoaderBars />}
        {visual === 'failed' && (
          <FailedBanner
            sessionId={(txState as { kind: 'failed'; sessionId: string }).sessionId}
          />
        )}
        {visual === 'disconnected' && deviceLost && (
          <DisconnectedBanner
            sessionId={deviceLost.sessionId}
            lastDeviceLabel={deviceLost.lastDeviceLabel}
            devices={deviceLost.devices}
            onResolved={() => setDeviceLost(null)}
          />
        )}
      </button>
      <MeetingButton
        // Stay visible while a meeting is recording so the user can stop it
        // without having to hover to reveal the button. Otherwise behaves
        // like HomeButton — opacity tied to group hover state.
        visible={hovered || (isRecording && mode === 'meeting')}
        // Non-clickable while a dictation is recording. Pointer-events go
        // through, click handler is unreachable, no tooltip on hover.
        disabled={isRecording && mode === 'dictation'}
        recordingMeeting={isRecording && mode === 'meeting'}
        canStart={recording === 'idle' && txState.kind === 'idle'}
        onEnter={() => setGroupHovered(true)}
        onLeave={() => setGroupHovered(false)}
        onStart={() => {
          void window.electronAPI.recording
            .startMeeting()
            .then((r) => {
              sessionIdRef.current = r.sessionId;
            })
            .catch(() => {});
        }}
        onStop={() => {
          const sid = sessionIdRef.current;
          if (sid) {
            void window.electronAPI.recording
              .stopMeeting({ sessionId: sid })
              .catch(() => {});
          }
        }}
      />
      <HomeButton
        visible={hovered}
        onEnter={() => setGroupHovered(true)}
        onLeave={() => setGroupHovered(false)}
      />
    </div>
  );
}

/**
 * "Take notes" — the only entry point for meeting mode. Same visual
 * footprint as HomeButton (7x7 dark-glass circle). Three states:
 *
 *   idle / not recording   →  Radio icon. Click starts a meeting.
 *   recording (this mode)  →  Red dot. Click stops the meeting.
 *   disabled (dictating)   →  Faded; pointer-events: none. Click impossible.
 *
 * Hovering shows a small "Take notes" tooltip above the button — a hint
 * that's specifically requested for discoverability since the icon alone
 * doesn't say "meeting".
 */
function MeetingButton({
  visible,
  disabled,
  recordingMeeting,
  canStart,
  onEnter,
  onLeave,
  onStart,
  onStop,
}: {
  visible: boolean;
  disabled: boolean;
  recordingMeeting: boolean;
  canStart: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onStart: () => void;
  onStop: () => void;
}) {
  const [tipShown, setTipShown] = useState(false);

  const handleClick = () => {
    if (disabled) return;
    if (recordingMeeting) {
      onStop();
      return;
    }
    if (canStart) onStart();
  };

  const handleEnter = () => {
    onEnter();
    if (!disabled) setTipShown(true);
  };
  const handleLeave = () => {
    onLeave();
    setTipShown(false);
  };

  return (
    <div className="relative">
      {tipShown && !disabled && !recordingMeeting && (
        // Centered above the button; small gap (1.5) so the tail of the
        // tooltip doesn't touch the button border. Dark-glass styling matches
        // the rest of the HUD chrome.
        <div
          className="pointer-events-none absolute bottom-full left-1/2 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-white/20 bg-black/80 px-2 py-0.5 text-[10px] font-medium text-white/90 backdrop-blur-md"
          role="tooltip"
        >
          Take notes
        </div>
      )}
      <button
        type="button"
        onClick={handleClick}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        aria-label={
          disabled
            ? 'Take notes (unavailable while dictating)'
            : recordingMeeting
              ? 'Stop meeting'
              : 'Take notes'
        }
        data-hud-interactive="true"
        className={[
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
          'border border-white/40 bg-black/55 backdrop-blur-md',
          'transition-opacity duration-150',
          disabled
            ? 'pointer-events-none opacity-40 text-white/40'
            : visible || recordingMeeting
              ? 'opacity-100 text-white/80 hover:text-white hover:bg-black/70'
              : 'pointer-events-none opacity-0 text-white/80',
        ].join(' ')}
      >
        {recordingMeeting ? (
          <span className="h-2 w-2 rounded-full bg-red-500" />
        ) : (
          <Radio className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

/**
 * Small circular button to the right of the main pill. Explicit "open the
 * main app" affordance — clicking the main pill starts/stops dictation, so
 * this is the only way to bring the main window forward without going
 * through a notification.
 *
 * Visible only while the user hovers the HUD (pill OR this button). The
 * pointer-events stay enabled while hidden so its own mouseenter can still
 * fire as the cursor approaches; the visual is faded with opacity instead.
 */
function HomeButton({
  visible,
  onEnter,
  onLeave,
}: {
  visible: boolean;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const onClick = () => {
    void window.electronAPI.main.showHome().catch(() => {});
  };
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      aria-label="Open TwinMind"
      data-hud-interactive="true"
      className={[
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
        'border border-white/40 bg-black/55 backdrop-blur-md',
        // shadow intentionally removed — the soft halo read as a faint
        // "box" around the Home button on transparent backdrops.
        'text-white/80 hover:text-white hover:bg-black/70',
        'transition-opacity duration-150',
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
      ].join(' ')}
    >
      <Home className="h-3.5 w-3.5" />
    </button>
  );
}

// ─── Visual sub-components ────────────────────────────────────────────────

type PillVisual =
  | 'recording'
  | 'processing'
  | 'failed'
  | 'disconnected'
  | 'hoverIdle'
  | 'busy'
  | 'idle';

/** Pill width per visual state. Idle is tiny; failed/disconnected are widest. */
function pillWidth(v: PillVisual): number {
  switch (v) {
    case 'idle':
      return 44;
    case 'hoverIdle':
      // Fallback used only if hoverIdleWidth(...) isn't applied (shouldn't
      // happen — JSX overrides this for hoverIdle). Kept for completeness.
      return 144;
    case 'busy':
      return 80;
    case 'recording':
      return 196;
    case 'processing':
      return 56;
    case 'failed':
      return 400;
    case 'disconnected':
      return 400;
  }
}

/**
 * Hover-idle pill width: grows with the hotkey label so the chip never
 * clips. Constants below cover the fixed parts: container padding (24px),
 * mic icon (~14px), gap (6px), "Dictate" text (~48px), chip padding/border
 * (~18px). The label itself is estimated at ~6.5px per char (the chip uses
 * a tabular-ish 10px font).
 */
function hoverIdleWidth(label: string): number {
  const FIXED = 24 + 14 + 6 + 48 + 18;
  const PER_CHAR = 6.5;
  return Math.max(140, Math.round(FIXED + label.length * PER_CHAR));
}

function pillHeight(v: PillVisual): number {
  if (v === 'failed' || v === 'disconnected') return PILL_HEIGHT_FAILED;
  if (v === 'idle') return PILL_HEIGHT_IDLE;
  return PILL_HEIGHT_EXPANDED;
}

/** Solid red dot with a soft outer halo while recording. */
function RecordingDot() {
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0 items-center justify-center">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500/50" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
    </span>
  );
}

/** Live recording waveform: 20 bars driven by the amplitude-sample buffer. */
function Waveform({ bars }: { bars: readonly number[] }) {
  return (
    <span className="flex h-full flex-1 items-center justify-center gap-[2px]">
      {bars.map((v, i) => {
        const scaled = Math.min(1, Math.sqrt(Math.max(0, v)) * AMP_GAIN);
        const px = Math.round(
          BAR_MIN_HEIGHT_PX + scaled * (BAR_MAX_HEIGHT_PX - BAR_MIN_HEIGHT_PX),
        );
        return (
          <span
            key={i}
            className="inline-block w-[2px] rounded-full bg-white/85 transition-[height] duration-100 ease-out"
            style={{ height: `${px}px` }}
          />
        );
      })}
    </span>
  );
}

/**
 * Circular loader: thin vertical bars arranged radially around a center.
 *
 * Each bar lives in a wrapper that fills the parent container and is rotated
 * to the bar's clock position; the bar itself sits at the top of that wrapper.
 * Rotating the wrapper pivots the bar around the container's center, which
 * is what produces the radial layout.
 *
 * Animation is pure CSS — each bar shares the same opacity-fade keyframe
 * with a negative animation-delay so they cycle in sequence. CSS-only means
 * no requestAnimationFrame loop and no React re-renders per frame.
 */
function LoaderBars() {
  return (
    <span className="relative inline-block h-6 w-6">
      <style>{LOADER_KEYFRAMES}</style>
      {Array.from({ length: LOADER_BAR_COUNT }).map((_, i) => (
        <span
          key={i}
          className="absolute inset-0"
          style={{ transform: `rotate(${(i * 360) / LOADER_BAR_COUNT}deg)` }}
        >
          <span
            className="absolute left-1/2 top-0 h-[6px] w-[2px] -translate-x-1/2 rounded-full bg-white"
            style={{
              animation: `hud-spin-fade ${LOADER_PERIOD_S}s linear infinite`,
              animationDelay: `${(-i * LOADER_PERIOD_S) / LOADER_BAR_COUNT}s`,
            }}
          />
        </span>
      ))}
    </span>
  );
}

const LOADER_KEYFRAMES = `
  @keyframes hud-spin-fade {
    0%   { opacity: 1; }
    100% { opacity: 0.18; }
  }
`;

/**
 * Keyframe used by the hover-idle content wrapper. Paired with a 150ms
 * `animation-delay` so the fade-in starts only after the pill's width
 * transition has finished — that's what eliminates the visible content
 * "settle" the user reported.
 */
const HOVER_CONTENT_KEYFRAMES = `
  @keyframes hud-hover-content-in {
    to { opacity: 1; }
  }
`;

/**
 * Failed banner: red ✕, message, Retry + History buttons. Retry triggers
 * `sessions.retryFailed` for the specific session that triggered this state;
 * the queue then retries that session up to 3 times again per RetryPolicy.
 * History brings the main window forward + switches to the Sessions tab.
 */
function FailedBanner({ sessionId }: { sessionId: string }) {
  const [retrying, setRetrying] = useState(false);
  const onRetry: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    if (retrying) return;
    setRetrying(true);
    void window.electronAPI.sessions
      .retryFailed({ sessionId })
      .catch(() => {})
      .finally(() => setRetrying(false));
  };
  const onHistory: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    void window.electronAPI.main.showSessionsTab().catch(() => {});
  };
  return (
    <span className="flex h-full w-full items-center justify-center gap-2">
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <span className="flex items-center gap-2">
          <X className="h-4 w-4 shrink-0 text-red-500" strokeWidth={3} />
          <span className="font-serif text-[16px] font-semibold leading-tight text-white">
            Something went wrong
          </span>
        </span>
        <span
          className="block text-left text-[13px] leading-snug text-white/75"
          style={{ paddingLeft: 24, textWrap: 'balance' }}
        >
          Transcription failed to load. But you can always recover it from the history.
        </span>
      </span>
      <span className="flex shrink-0 flex-col justify-center gap-1.5">
        <button
          type="button"
          onClick={onHistory}
          className="flex w-20 items-center justify-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[12px] font-medium text-white/85 hover:bg-white/10"
        >
          <History className="h-3.5 w-3.5" />
          History
        </button>
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="flex w-20 items-center justify-center gap-1 rounded-md border border-amber-700/70 bg-amber-900/40 px-2 py-1 text-[12px] font-medium text-amber-100 hover:bg-amber-900/60 disabled:opacity-60"
        >
          <RotateCw className={`h-3.5 w-3.5 ${retrying ? 'animate-spin' : ''}`} />
          Retry
        </button>
      </span>
    </span>
  );
}

/**
 * Disconnected banner: shown when the user's pinned mic disappeared
 * mid-recording. Inline dropdown lists the currently available input
 * devices (Auto-detect + Built-in + Other). Resume picks the selected
 * device, persists it as the new `recording.inputDeviceId`, and tells
 * the orchestrator to resume the paused session with a fresh chunk
 * marked `device_boundary=true`. Stop ends the session like a normal
 * user-stop.
 */
function DisconnectedBanner({
  sessionId,
  lastDeviceLabel,
  devices,
  onResolved,
}: {
  sessionId: string;
  lastDeviceLabel: string | null;
  devices: ReadonlyArray<{
    id: string;
    name: string;
    isDefault: boolean;
    kind: 'built_in' | 'bluetooth' | 'usb' | 'other';
  }>;
  onResolved: () => void;
}) {
  const [selected, setSelected] = useState<string>(''); // '' = Auto-detect
  const [busy, setBusy] = useState(false);

  const onResume: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    const deviceId = selected === '' ? null : selected;
    void window.electronAPI.recording_devices
      .resumeFromDeviceLoss({ sessionId, deviceId })
      .catch(() => {})
      .finally(() => {
        setBusy(false);
        // Clear locally — main will also push recording_state to 'recording'
        // which clears it again, but doing it here avoids a one-frame stale
        // banner if the IPC reply is slow.
        onResolved();
      });
  };

  const onStop: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    // Use the existing stopMeeting channel — it stops whichever session is
    // active under the given id. The orchestrator marks ended; our local
    // state clears when 'recording_state' fires with state='idle'.
    void window.electronAPI.recording
      .stopMeeting({ sessionId })
      .catch(() => {})
      .finally(() => {
        setBusy(false);
        onResolved();
      });
  };

  const builtIn = devices.filter((d) => d.kind === 'built_in');
  const other = devices.filter((d) => d.kind !== 'built_in');

  return (
    <span className="flex h-full w-full items-center justify-center gap-2">
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <span className="flex items-center gap-2">
          <MicOff className="h-4 w-4 shrink-0 text-amber-400" strokeWidth={2.5} />
          <span className="font-serif text-[16px] font-semibold leading-tight text-white">
            Mic disconnected
          </span>
        </span>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          className="ml-6 max-w-[200px] rounded-md border border-white/15 bg-white/5 px-1.5 py-0.5 text-[12px] text-white/85"
        >
          <option value="">Auto-detect (system default)</option>
          {builtIn.length > 0 && (
            <optgroup label="Built-in">
              {builtIn.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </optgroup>
          )}
          {other.length > 0 && (
            <optgroup label="Other devices">
              {other.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {lastDeviceLabel && (
          <span className="ml-6 text-[11px] text-white/55">
            Was: {lastDeviceLabel}
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-col justify-center gap-1.5">
        <button
          type="button"
          onClick={onStop}
          disabled={busy}
          className="flex w-20 items-center justify-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[12px] font-medium text-white/85 hover:bg-white/10 disabled:opacity-60"
        >
          Stop
        </button>
        <button
          type="button"
          onClick={onResume}
          disabled={busy}
          className="flex w-20 items-center justify-center gap-1 rounded-md border border-emerald-700/70 bg-emerald-900/40 px-2 py-1 text-[12px] font-medium text-emerald-100 hover:bg-emerald-900/60 disabled:opacity-60"
        >
          Resume
        </button>
      </span>
    </span>
  );
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

