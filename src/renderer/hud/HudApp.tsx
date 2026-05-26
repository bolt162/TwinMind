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
import { Clock, ClipboardCheck, Mic, MicOff, Radio, RotateCw, History, X, Home } from 'lucide-react';
import { formatHotkey, type Hotkey } from '@core/hotkey/HotkeyTypes';

type RecordingState = 'idle' | 'starting' | 'recording' | 'stopping';
type RecordingMode = 'idle' | 'dictation' | 'meeting';
type TranscriptionUiState =
  | { kind: 'idle' }
  | { kind: 'processing' }
  | { kind: 'failed'; sessionId: string }
  | { kind: 'dictation_limit_reached'; sessionId: string };

const BAR_COUNT = 20;
const DECAY = 0.86;
const PILL_HEIGHT_EXPANDED = 32;
// Idle pill matches the processing pill's outer shape (56 × 32) so the
// resting state reads with the same visual weight as the working state.
// Drag clamp + edge-anchor calc in FloatingHudWindow rely on these
// dimensions matching `PILL_IDLE_WIDTH / HEIGHT` there — keep in sync.
const PILL_HEIGHT_IDLE = 32;
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
  /**
   * Set when main pushes MIC_PERMISSION_REQUIRED — i.e. the user tried to
   * start a recording but the macOS mic permission isn't `granted`. HUD
   * shows the "Please grant Microphone permission" banner; cleared by the
   * Dismiss button.
   *
   * We carry the OS grant alongside `mode` because the banner's primary
   * action branches on it: `not_determined` fires the OS request dialog
   * (macOS won't show TwinMind in the Privacy panel until askForMediaAccess
   * has been called at least once); `denied`/`unavailable` opens Privacy →
   * Microphone where the toggle lives.
   */
  const [micPermissionRequired, setMicPermissionRequired] = useState<{
    mode: 'dictation' | 'meeting';
    grant: 'denied' | 'not_determined' | 'unavailable';
  } | null>(null);
  /**
   * Set when main pushes ACCESSIBILITY_LOST with `granted: false` — the user
   * revoked TwinMind's Accessibility grant mid-session. Fn dictation +
   * configurable hotkeys + auto-paste are all dead until the user re-grants.
   * Cleared automatically when main pushes `granted: true` again (no
   * Dismiss button — the only useful action is to re-grant).
   */
  const [accessibilityRequired, setAccessibilityRequired] = useState(false);
  /**
   * Set when main pushes HUD_CLIPBOARD_TOAST — dictation text was written
   * to the clipboard but couldn't auto-paste (Accessibility denied or
   * native paste failed). Pill briefly becomes a "Copied to clipboard ✓"
   * toast that fades out over 2 s, then reverts to idle.
   *
   * Auto-dismiss handled in the subscriber via setTimeout. Restartable —
   * a second paste while the toast is up resets the 2 s window.
   */
  const [copiedToastVisible, setCopiedToastVisible] = useState(false);
  const copiedToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Edge anchor pushed by main when the pill is near a workArea edge.
   * Used to flip the hover-group expansion direction so Capture notes + Home
   * appear on the side AWAY from the edge (toward the screen interior).
   */
  const [edgeAnchor, setEdgeAnchor] = useState<{
    x: 'left' | 'right' | 'center';
    y: 'top' | 'bottom' | 'center';
  }>({ x: 'center', y: 'center' });
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
      // 350 ms grace covers a slow-cursor traversal of the full hover
      // group (Dictate → Capture notes → Home ≈ 270 px at typical casual
      // speeds). Earlier 180 ms was tight when Capture notes was an icon-
      // only chip; with the wider pill it's no longer enough.
      hoverTimeoutRef.current = setTimeout(() => setHovered(false), 350);
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
      // new "Capture notes" button for meetings).
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
    // Edge-anchor pushes drive the hover-group expansion direction. Main
    // recomputes after every drag move + state change.
    const unsubAnchor = window.electronAPI.on.hudEdgeAnchor((e) => {
      setEdgeAnchor(e);
    });
    const unsubMicPerm = window.electronAPI.on.micPermissionRequired((e) => {
      setMicPermissionRequired({ mode: e.mode, grant: e.grant });
    });
    const unsubAxLost = window.electronAPI.on.accessibilityLost((e) => {
      setAccessibilityRequired(!e.granted);
    });
    const unsubClipboardToast = window.electronAPI.on.hudClipboardToast(() => {
      setCopiedToastVisible(true);
      // Restart the 2 s window if a second paste fires while the toast is
      // still up. Ref-stored so successive pushes don't pile up timers.
      if (copiedToastTimerRef.current) clearTimeout(copiedToastTimerRef.current);
      copiedToastTimerRef.current = setTimeout(() => {
        setCopiedToastVisible(false);
        copiedToastTimerRef.current = null;
      }, 2000);
    });
    return () => {
      unsubRec();
      unsubTx();
      unsubHotkey();
      unsubLost();
      unsubAuth();
      unsubAnchor();
      unsubMicPerm();
      unsubAxLost();
      unsubClipboardToast();
      if (copiedToastTimerRef.current) {
        clearTimeout(copiedToastTimerRef.current);
        copiedToastTimerRef.current = null;
      }
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
    | 'micPermission'
    | 'accessibilityRequired'
    | 'dictationLimit'
    | 'disconnected'
    | 'copiedToast'
    | 'hoverIdle'
    | 'busy'
    | 'idle';
  // accessibilityRequired is the highest priority — revoking Accessibility
  // disables Fn dictation + configurable hotkeys + auto-paste at once, and
  // (per the system-freeze bug we just patched) is the single most dangerous
  // permission to lose. micPermission is next — start was blocked before the
  // orchestrator ran, so there's no recording / processing competing for the
  // slot. dictationLimit + disconnected come after — banners the user has to
  // acknowledge. dictationLimit wins over recording because the orchestrator
  // already stopped the session when it fired the limit.
  // copiedToast sits BELOW recording / banners / processing so a new
  // dictation that fires within the 2 s toast window immediately reclaims
  // the pill, and ABOVE hoverIdle so hovering during the toast doesn't
  // hide the "Copied to clipboard ✓" message.
  const visual: Visual = accessibilityRequired
    ? 'accessibilityRequired'
    : micPermissionRequired
      ? 'micPermission'
      : txState.kind === 'dictation_limit_reached'
        ? 'dictationLimit'
        : deviceLost && !isRecording
          ? 'disconnected'
          : isRecording
            ? 'recording'
            : isBusy
              ? 'busy'
              : txState.kind === 'processing'
                ? 'processing'
                : txState.kind === 'failed'
                  ? 'failed'
                  : copiedToastVisible
                    ? 'copiedToast'
                    : hovered
                      ? 'hoverIdle'
                      : 'idle';
  const expanded = visual !== 'idle';
  // Every wide-banner state (the user is being asked to act on a specific
  // problem). Home + Capture notes are pulled out of the layout while a banner
  // is showing — otherwise hovering the wide banner reveals them and they
  // compete with the banner's own buttons for the user's attention.
  const bannerVisible =
    visual === 'failed' ||
    visual === 'dictationLimit' ||
    visual === 'disconnected' ||
    visual === 'micPermission' ||
    visual === 'accessibilityRequired';
  // Capture notes + Home pop out on hover only when the pill is in a
  // user-driven idle/hoverIdle state. We explicitly suppress them while
  // the pill is showing a transient or working state — processing
  // (chunks uploading after a dictation stop), busy (starting/stopping),
  // copiedToast (post-paste fade). Otherwise hovering the still-visible
  // pill during these moments would surface buttons the user can't
  // meaningfully act on (Capture notes is start-only and blocked by
  // `isBlockingNewRecording`; Home is fine but inconsistent UX).
  const hoverButtonsVisible =
    hovered &&
    !bannerVisible &&
    visual !== 'processing' &&
    visual !== 'busy' &&
    visual !== 'copiedToast';

  // Notify main of the current visual state. Main uses this to decide
  // whether to shift the HUD window so larger states (banner: 400 × 100)
  // fit inside the workArea even when the user dragged the idle pill near
  // an edge. State transitions that fit at the anchor are no-ops in main;
  // only the banner states actually move the window.
  useEffect(() => {
    void window.electronAPI.hud.setVisualState({ visual }).catch(() => {
      /* HUD detached / IPC down — harmless */
    });
  }, [visual]);

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

  const onPillClick = () => {
    if (dragMoved.current) {
      dragMoved.current = false;
      return;
    }
    if (isBusy) return;
    // Banner up → the only valid actions are the Open settings / Dismiss
    // buttons inside the banner (they stopPropagation). A click on the
    // pill body itself would otherwise re-fire startDictation → re-push
    // the banner. Idempotent but pointless; just no-op.
    if (micPermissionRequired) return;
    if (accessibilityRequired) return;
    if (recording === 'idle' && txState.kind === 'idle') {
      void window.electronAPI.recording.startDictation().catch(() => {});
    } else if (isRecording && mode === 'dictation') {
      void window.electronAPI.recording.stopDictation().catch(() => {});
    } else if (isRecording && mode === 'meeting') {
      const sid = sessionIdRef.current;
      if (sid) {
        void window.electronAPI.recording.stopMeeting({ sessionId: sid }).catch(() => {});
      }
    }
    // For 'processing' and 'failed' states, clicks on the pill itself are no-ops
    // — the retry/history buttons inside the pill are what the user touches.
  };

  return (
    <div className="flex h-full w-full items-center justify-center">
      {/*
        Layout wrapper only — NO hover handlers and NO data-hud-interactive
        attribute. Hover is per-button: the Dictate pill is the only entry
        point that flips `hovered` to true; Home + Capture notes have their
        own onMouseEnter to KEEP it true while the cursor traverses to
        them. The 350 ms grace timer in `setGroupHovered(false)` covers
        the brief 8 px gap traversal between visible buttons.
        Side effect: the 8 px gaps between buttons are now click-through,
        which is correct — they're not interactive surfaces.
        Previously this wrapper had a full-row hover hit-box that fired
        even when the cursor was over empty space where Capture notes
        WOULD appear if hovered — surfacing the buttons unintentionally.
      */}
      <div
        className={[
          'flex items-center gap-2',
          // Group layout is [Home] [Dictate] [Capture notes]. When the pill is
          // hugging the RIGHT edge of workArea, default flex-row puts Take
          // Notes off the edge; flex-row-reverse swaps the order so the
          // small (28 px) Home button trails the pill instead of the wider
          // (~120 px) Capture notes pill — much less overflow. Left edge
          // intentionally NOT flipped because reversing there would push
          // Capture notes (big) off-screen instead of Home (small).
          edgeAnchor.x === 'right' ? 'flex-row-reverse' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
      <HomeButton
        visible={hoverButtonsVisible}
        onEnter={() => setGroupHovered(true)}
        onLeave={() => setGroupHovered(false)}
      />
      <button
        type="button"
        onClick={onPillClick}
        onMouseDown={onMouseDown}
        onMouseEnter={() => setGroupHovered(true)}
        onMouseLeave={() => setGroupHovered(false)}
        data-hud-interactive="true"
        aria-label={
          visual === 'recording'
            ? (mode === 'meeting' ? 'Stop meeting' : 'Stop dictation')
            : visual === 'failed'
              ? 'Transcription failed; retry or open history'
              : visual === 'processing'
                ? 'Retrying transcription'
                : visual === 'disconnected'
                  ? 'Microphone disconnected; pick a device to resume'
                  : visual === 'dictationLimit'
                    ? 'Dictation limit reached; dismiss or start a new dictation'
                    : visual === 'micPermission'
                      ? 'Microphone permission required; open settings or dismiss'
                      : visual === 'accessibilityRequired'
                        ? 'Accessibility permission required; open settings to restore Fn dictation'
                        : 'Start dictation'
        }
        className={[
          // justify-center keeps single-child states (idle EQ glyph,
          // processing LoaderBars, busy dot+ellipsis) visually centered
          // in the pill regardless of content area width. Has no effect
          // on hoverIdle / recording, since those have a flex-1 child
          // that fills available space (nothing to justify).
          'flex items-center justify-center gap-1 rounded-full',
          'border border-white/40',
          'bg-black',
          'transition-[width,height,padding,opacity] duration-150 ease-out',
          'overflow-hidden text-white select-none cursor-grab active:cursor-grabbing',
          visual === 'failed' ||
          visual === 'disconnected' ||
          visual === 'dictationLimit' ||
          visual === 'micPermission' ||
          visual === 'accessibilityRequired'
            ? 'px-6 py-4 items-stretch'
            : visual === 'recording'
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
          <Mic className="mx-auto h-4 w-4 text-white" aria-hidden />
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
        {visual === 'copiedToast' && (
          // Content fades to 0 over 2 s — the pill itself stays mounted
          // until the parent state flips back to idle (also at 2 s), so
          // the fade and the visual transition land together. CSS-only
          // animation avoids per-frame React renders.
          <span
            className="flex items-center gap-1.5"
            style={{ animation: 'hud-copied-toast-fade 2s ease-out forwards' }}
          >
            <style>{COPIED_TOAST_KEYFRAMES}</style>
            <ClipboardCheck className="h-3.5 w-3.5 text-emerald-300" aria-hidden />
            <span className="text-[11px] font-medium tracking-wide text-white/90">
              Copied to clipboard
            </span>
          </span>
        )}
        {visual === 'recording' && (
          <>
            <span
              className="h-2 w-2 shrink-0 rounded-[1px] bg-red-500"
              aria-hidden
            />
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
        {visual === 'dictationLimit' && (
          <DictationLimitBanner />
        )}
        {visual === 'disconnected' && deviceLost && (
          <DisconnectedBanner
            sessionId={deviceLost.sessionId}
            lastDeviceLabel={deviceLost.lastDeviceLabel}
            devices={deviceLost.devices}
            onResolved={() => setDeviceLost(null)}
          />
        )}
        {visual === 'micPermission' && micPermissionRequired && (
          <MicPermissionBanner
            grant={micPermissionRequired.grant}
            onDismiss={() => setMicPermissionRequired(null)}
            onGrantTransition={(next) =>
              setMicPermissionRequired((prev) =>
                prev ? { ...prev, grant: next } : prev,
              )
            }
          />
        )}
        {visual === 'accessibilityRequired' && (
          <AccessibilityBanner onDismiss={() => setAccessibilityRequired(false)} />
        )}
      </button>
      {/*
        Conditional render — not just opacity-0 — so Capture notes is COMPLETELY
        gone from the DOM/layout whenever a recording session is active (either
        mode). The main pill IS the stop affordance for both modes, so this
        button is start-only. Pops back into the layout when the session
        ends (no transition; instant reappearance).
      */}
      {recording === 'idle' && (
      <MeetingButton
        visible={hoverButtonsVisible}
        // Drag plumbing — share the parent's drag refs so Capture notes is a
        // valid grab-handle for moving the HUD, same as the Dictate pill.
        // getDragMoved/clearDragMoved let handleClick suppress its own
        // start action when a drag ended over the button.
        onMouseDown={onMouseDown}
        getDragMoved={() => dragMoved.current}
        clearDragMoved={() => { dragMoved.current = false; }}
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
      />
      )}
      </div>
    </div>
  );
}

/**
 * "Capture notes" — the start-only entry point for meeting mode. Renders
 * only while no session is active; clicking it starts a meeting, after
 * which the main pill takes over as the recording HUD (waveform + timer +
 * red stop square) and stops the meeting on click.
 */
function MeetingButton({
  visible,
  canStart,
  onEnter,
  onLeave,
  onStart,
  onMouseDown,
  getDragMoved,
  clearDragMoved,
}: {
  visible: boolean;
  canStart: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onStart: () => void;
  /** Forwarded from HudApp so dragging from this button moves the window. */
  onMouseDown?: React.MouseEventHandler<HTMLButtonElement>;
  /** Lets us check whether the just-completed gesture was a drag. */
  getDragMoved?: () => boolean;
  /** Resets the shared drag flag after we've consumed it in handleClick. */
  clearDragMoved?: () => void;
}) {
  const handleClick = () => {
    // Same guard as the main pill: if the user dragged the HUD while
    // holding this button, the mouseup fires a click — swallow it so the
    // drag-to-reposition gesture doesn't also start a meeting.
    if (getDragMoved?.()) {
      clearDragMoved?.();
      return;
    }
    if (canStart) onStart();
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      onMouseDown={onMouseDown}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      aria-label="Capture notes"
      data-hud-interactive="true"
      className={[
        // h-8 (32 px) intentionally matches PILL_HEIGHT_EXPANDED on the
        // main pill so the two pills sit at the same baseline in
        // hoverIdle. Previously h-7 (28 px) made them visibly mismatched.
        'flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3',
        'border border-white/40 bg-black',
        'transition-opacity duration-150',
        visible
          ? 'opacity-100 text-white/85 hover:text-white'
          : 'pointer-events-none opacity-0 text-white/85',
      ].join(' ')}
    >
      <Radio className="h-3.5 w-3.5 shrink-0" />
      <span className="text-[11px] font-medium tracking-wide">
        Capture notes
      </span>
    </button>
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
        'border border-white/40 bg-black',
        'text-white/80 hover:text-white',
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
  | 'micPermission'
  | 'accessibilityRequired'
  | 'dictationLimit'
  | 'disconnected'
  | 'copiedToast'
  | 'hoverIdle'
  | 'busy'
  | 'idle';

/** Pill width per visual state. Failed/disconnected are widest. */
function pillWidth(v: PillVisual): number {
  switch (v) {
    case 'idle':
      // Match processing's width so idle and processing share the same
      // outer shape (= matches PILL_IDLE_WIDTH in FloatingHudWindow.ts).
      return 56;
    case 'hoverIdle':
      // Fallback used only if hoverIdleWidth(...) isn't applied (shouldn't
      // happen — JSX overrides this for hoverIdle). Kept for completeness.
      return 144;
    case 'busy':
      return 80;
    case 'recording':
      return 148;
    case 'processing':
      return 56;
    case 'failed':
      return 400;
    case 'disconnected':
      return 400;
    case 'dictationLimit':
      return 400;
    case 'micPermission':
      return 400;
    case 'accessibilityRequired':
      return 400;
    case 'copiedToast':
      // Wide enough for icon + "Copied to clipboard" at 11px font; matches
      // FloatingHudWindow.VISUAL_BOUNDS.copiedToast.width so the bg pill
      // and the OS window grow together.
      return 180;
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
  if (
    v === 'failed' ||
    v === 'disconnected' ||
    v === 'dictationLimit' ||
    v === 'micPermission' ||
    v === 'accessibilityRequired'
  ) {
    return PILL_HEIGHT_FAILED;
  }
  if (v === 'idle') return PILL_HEIGHT_IDLE;
  return PILL_HEIGHT_EXPANDED;
}

/** Live recording waveform: 20 bars driven by the amplitude-sample buffer. */
function Waveform({ bars }: { bars: readonly number[] }) {
  return (
    <span className="flex h-full flex-1 items-center justify-center gap-[1px]">
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
    <span className="relative inline-block h-4 w-4">
      <style>{LOADER_KEYFRAMES}</style>
      {Array.from({ length: LOADER_BAR_COUNT }).map((_, i) => (
        <span
          key={i}
          className="absolute inset-0"
          style={{ transform: `rotate(${(i * 360) / LOADER_BAR_COUNT}deg)` }}
        >
          <span
            className="absolute left-1/2 top-0 h-[4px] w-[1.5px] -translate-x-1/2 rounded-full bg-white"
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
 * 2-second fade-out for the "Copied to clipboard ✓" pill. The pill stays
 * fully visible for the first half second, then ramps to 0 opacity over
 * the next 1.5 seconds — a long-tail fade reads as "this is finished"
 * better than a sharp cut. Parent flips the visual back to 'idle' at
 * the same 2 s mark so the pill unmounts as the fade completes.
 */
const COPIED_TOAST_KEYFRAMES = `
  @keyframes hud-copied-toast-fade {
    0%   { opacity: 1; }
    25%  { opacity: 1; }
    100% { opacity: 0; }
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
 * Dictation-limit banner: shown when the 5-minute dictation hard cap
 * fires. Same dimensions as FailedBanner. Two buttons in the right column:
 *
 *   Dismiss  — clears the limit state (REC_DICTATION_LIMIT_DISMISS).
 *              HUD returns to whatever underlying state is live: 'processing'
 *              if the just-stopped session's chunks are still uploading,
 *              else 'idle'. Either way the old transcripts continue to land
 *              and paste in the background.
 *   Dictate  — dismisses + starts a fresh dictation session.
 *
 * Visual mirrors FailedBanner exactly so the user reads "this is a prompt"
 * the same way they do for transcription failure.
 */
function DictationLimitBanner() {
  const [busy, setBusy] = useState(false);
  const onDismiss: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    void window.electronAPI.recording
      .dictationLimitDismiss()
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  const onDictate: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    // Order matters: startDictation FIRST, then dismiss the banner state.
    // While state is 'dictation_limit_reached', `isBlockingNewRecording`
    // returns false (it only blocks on 'processing'); the just-stopped
    // dictation's chunk is still uploading in the background but that
    // shouldn't gate a fresh start triggered explicitly by the banner.
    // Dismissing first would flip the state to 'processing' and the
    // startDictation IPC would no-op silently.
    void window.electronAPI.recording
      .startDictation()
      .then(() => window.electronAPI.recording.dictationLimitDismiss())
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  return (
    <span className="flex h-full w-full items-center justify-center gap-2">
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <span className="flex items-center gap-2">
          <Clock className="h-4 w-4 shrink-0 text-white/80" strokeWidth={2.25} />
          <span className="font-serif text-[16px] font-semibold leading-tight text-white">
            Dictation limit reached
          </span>
        </span>
        <span
          className="block text-left text-[13px] leading-snug text-white/75"
          style={{ paddingLeft: 24, textWrap: 'balance' }}
        >
          Start new dictation?
        </span>
      </span>
      <span className="flex shrink-0 flex-col justify-center gap-1.5">
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="flex w-20 items-center justify-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[12px] font-medium text-white/85 hover:bg-white/10 disabled:opacity-60"
        >
          Dismiss
        </button>
        <button
          type="button"
          onClick={onDictate}
          disabled={busy}
          className="flex w-20 items-center justify-center gap-1 rounded-md border border-amber-700/70 bg-amber-900/40 px-2 py-1 text-[12px] font-medium text-amber-100 hover:bg-amber-900/60 disabled:opacity-60"
        >
          <Mic className="h-3.5 w-3.5" />
          Dictate
        </button>
      </span>
    </span>
  );
}

/**
 * Mic permission banner: shown when a recording-start attempt was
 * rejected because the macOS mic permission isn't `granted`. The primary
 * action branches on the current TCC grant — see the MicPermissionRequired
 * payload doc in channels.ts for the reasoning.
 *
 *   grant=not_determined → "Allow" → fires the OS request dialog via
 *                          PERMISSIONS_REQUEST_MIC. macOS hasn't yet
 *                          registered TwinMind in Privacy → Microphone,
 *                          so deep-linking there from this state would
 *                          land on an empty list — useless. We MUST
 *                          trigger the dialog from this state.
 *                          If the user denies in the dialog, we flip
 *                          the local grant to 'denied' via
 *                          onGrantTransition so the same banner
 *                          re-renders with the open-settings path.
 *   grant=denied/unavailable → "Open settings" → deep-links to Privacy →
 *                          Microphone, where TwinMind IS registered with
 *                          the toggle off and the user can flip it on.
 *
 *   Dismiss in both branches clears the local banner state; HUD returns
 *   to idle. The orchestrator was never started, so no main-side cleanup.
 */
function MicPermissionBanner({
  grant,
  onDismiss,
  onGrantTransition,
}: {
  grant: 'denied' | 'not_determined' | 'unavailable';
  onDismiss: () => void;
  /**
   * Called when the in-banner OS dialog finishes with a deny — the banner
   * needs to flip from the "Allow" branch to the "Open settings" branch
   * without going back through main. Parent updates its state; the
   * banner re-renders with the new grant on the next React tick.
   */
  onGrantTransition: (next: 'denied' | 'not_determined' | 'unavailable') => void;
}) {
  const [busy, setBusy] = useState(false);
  const isNotDetermined = grant === 'not_determined';
  const onPrimary: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    if (isNotDetermined) {
      void window.electronAPI.permissions
        .requestMic()
        .then((r) => {
          if (r.granted) {
            // Granted via dialog — clear the banner. Orchestrator wasn't
            // started, so the user clicks the pill again to record.
            onDismiss();
          } else {
            // Denied in the dialog — banner stays up but flips to the
            // open-settings path since further requestMic() calls will
            // no-op (macOS doesn't re-prompt after a deny).
            onGrantTransition('denied');
          }
        })
        .catch(() => {})
        .finally(() => setBusy(false));
    } else {
      void window.electronAPI.permissions
        .openSystemSettings({ kind: 'mic' })
        .catch(() => {})
        .finally(() => setBusy(false));
    }
  };
  const onDismissClick: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    onDismiss();
  };
  const primaryLabel = isNotDetermined
    ? busy
      ? 'Requesting…'
      : 'Allow'
    : busy
      ? 'Opening…'
      : 'Open settings';
  return (
    <span className="flex h-full w-full items-center justify-center gap-2">
      {/* Single-line headline — the other banners have a sub-line and use
          flex-col gap-1; here we just centre the one row vertically against
          the 100 px banner so it doesn't float near the top. */}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <MicOff className="h-4 w-4 shrink-0 text-red-500" strokeWidth={2.5} />
        <span className="font-serif text-[16px] font-semibold leading-tight text-white">
          Please grant Microphone permission
        </span>
      </span>
      <span className="flex shrink-0 flex-col justify-center gap-1.5">
        <button
          type="button"
          onClick={onPrimary}
          disabled={busy}
          className="flex w-28 items-center justify-center gap-1 rounded-md border border-amber-700/70 bg-amber-900/40 px-2 py-1 text-[12px] font-medium text-amber-100 hover:bg-amber-900/60 disabled:opacity-60"
        >
          {primaryLabel}
        </button>
        <button
          type="button"
          onClick={onDismissClick}
          className="flex w-28 items-center justify-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[12px] font-medium text-white/85 hover:bg-white/10"
        >
          Dismiss
        </button>
      </span>
    </span>
  );
}

/**
 * Accessibility-required banner: shown when main pushes ACCESSIBILITY_LOST
 * with `granted: false` — the user revoked TwinMind's Accessibility grant
 * mid-session. Two buttons:
 *
 *   Settings — deep-links to System Settings → Privacy → Accessibility.
 *   Dismiss  — clears the local banner state; HUD returns to idle.
 *              Re-appears on the next revoke transition; auto-clears when
 *              main pushes `granted: true`.
 *
 * Single-line headline (no body copy) so the layout matches the mic-
 * permission banner.
 */
function AccessibilityBanner({ onDismiss }: { onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  const onOpenSettings: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    void window.electronAPI.permissions
      .openSystemSettings({ kind: 'accessibility' })
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  const onDismissClick: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    onDismiss();
  };
  return (
    <span className="flex h-full w-full items-center justify-center gap-2">
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <MicOff className="h-4 w-4 shrink-0 text-red-500" strokeWidth={2.5} />
        <span className="font-serif text-[16px] font-semibold leading-tight text-white">
          Accessibility access lost
        </span>
      </span>
      <span className="flex shrink-0 flex-col justify-center gap-1.5">
        <button
          type="button"
          onClick={onOpenSettings}
          disabled={busy}
          className="flex w-28 items-center justify-center gap-1 rounded-md border border-amber-700/70 bg-amber-900/40 px-2 py-1 text-[12px] font-medium text-amber-100 hover:bg-amber-900/60 disabled:opacity-60"
        >
          Settings
        </button>
        <button
          type="button"
          onClick={onDismissClick}
          className="flex w-28 items-center justify-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[12px] font-medium text-white/85 hover:bg-white/10"
        >
          Dismiss
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
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  // After the first hour, switch from MM:SS to H:MM:SS so a long meeting
  // doesn't read as "61:30" / "127:00". Sub-hour stays MM:SS — matches the
  // QuickTime / GarageBand convention of hiding zero leading components.
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

