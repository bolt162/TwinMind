/**
 * DarwinPermissionService — macOS TCC permission checks + prompts.
 *
 * Architecture: §12.5 (permissions matrix), §16.1 (onboarding flow).
 *
 * The four permissions we care about:
 *   - mic           → `systemPreferences.getMediaAccessStatus('microphone')`
 *   - audioCapture  → native TCC preflight/request against `kTCCServiceAudioCapture`
 *                     (the NSAudioCaptureUsageDescription permission used by
 *                     Core Audio Taps; no public Electron API exposes this)
 *   - accessibility → `systemPreferences.isTrustedAccessibilityClient(false)`
 *   - notifications → no Electron API; treated as `granted` once we attempt
 *                     to post a Notification (the OS surfaces the prompt).
 *
 * For deep-linking to the Privacy pane we shell out to `x-apple.systempreferences:`
 * URLs — supported on macOS 10.10+.
 */

import { shell, systemPreferences } from 'electron';
import type {
  IPermissionService,
  PermissionGrant,
  PermissionKind,
} from '../IPermissionService';

// Native TCC introspection lives in @twinmind/coreaudio-darwin. We lazy-load
// it so darwin-only code can be imported during tests on other platforms
// without dragging the native binary along. If the addon isn't available the
// audioCapture path degrades to 'not_determined', matching the previous
// behavior.
type TccGrant = 'authorized' | 'denied' | 'not_determined' | 'unavailable';
interface TccAddonShape {
  audioCapturePreflight?: () => TccGrant;
  audioCaptureRequest?: () => Promise<'authorized' | 'denied' | 'unavailable'>;
}
let tccAddonCached: TccAddonShape | null | undefined;
function loadTccAddon(): TccAddonShape | null {
  if (tccAddonCached !== undefined) return tccAddonCached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    tccAddonCached = require('@twinmind/coreaudio-darwin') as TccAddonShape;
  } catch {
    tccAddonCached = null;
  }
  return tccAddonCached;
}

function tccGrantToPermissionGrant(g: TccGrant): PermissionGrant {
  switch (g) {
    case 'authorized':
      return 'granted';
    case 'denied':
      return 'denied';
    case 'not_determined':
      return 'not_determined';
    case 'unavailable':
    default:
      // Future-macOS or addon missing: surface as not_determined so the UI
      // shows an "Allow" button rather than a confusing "Denied" pill.
      return 'not_determined';
  }
}

const PRIVACY_DEEP_LINKS: Record<PermissionKind, string | null> = {
  mic: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  audioCapture:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture',
  accessibility:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  notifications: null,
};

/** Convert macOS's mic-access-status enum to our grant enum. */
function mediaStatusToGrant(
  status: ReturnType<typeof systemPreferences.getMediaAccessStatus>,
): PermissionGrant {
  switch (status) {
    case 'granted':
      return 'granted';
    case 'denied':
    case 'restricted':
      return 'denied';
    case 'not-determined':
      return 'not_determined';
    case 'unknown':
    default:
      return 'unavailable';
  }
}

export class DarwinPermissionService implements IPermissionService {
  /** Synchronous read of one permission's current state. */
  read(kind: PermissionKind): PermissionGrant {
    switch (kind) {
      case 'mic':
        return mediaStatusToGrant(systemPreferences.getMediaAccessStatus('microphone'));
      case 'audioCapture': {
        // Electron 36's `getMediaAccessStatus` only knows microphone/camera/screen.
        // We go through the private TCC.framework (via the native addon) for
        // kTCCServiceAudioCapture. This is a pure DB lookup — no Core Audio
        // tap is opened, so it's safe to call while audiotee is recording.
        const addon = loadTccAddon();
        if (!addon || typeof addon.audioCapturePreflight !== 'function') {
          return 'not_determined';
        }
        return tccGrantToPermissionGrant(addon.audioCapturePreflight());
      }
      case 'accessibility':
        return systemPreferences.isTrustedAccessibilityClient(false)
          ? 'granted'
          : 'not_determined';
      case 'notifications':
        // No introspection API; we optimistically report 'granted'. Show() will
        // surface the OS prompt the first time and the user will allow/deny.
        return 'granted';
    }
  }

  /** Prompt for one permission and return the resulting grant. */
  async request(kind: PermissionKind): Promise<PermissionGrant> {
    switch (kind) {
      case 'mic': {
        const ok = await systemPreferences.askForMediaAccess('microphone');
        return ok ? 'granted' : 'denied';
      }
      case 'audioCapture': {
        // Surface the OS prompt via TCC.framework's TCCAccessRequest. If the
        // grant is already determined, the call resolves with the current
        // state without showing UI. Does NOT open a Core Audio tap, so it is
        // safe to call while audiotee is recording (though in practice the
        // grant will already be 'granted' by then and the button is hidden).
        const addon = loadTccAddon();
        if (!addon || typeof addon.audioCaptureRequest !== 'function') {
          return 'not_determined';
        }
        const r = await addon.audioCaptureRequest();
        return tccGrantToPermissionGrant(r);
      }
      case 'accessibility': {
        // Calling with `true` surfaces the system prompt; the user then has
        // to flip the toggle in System Settings.
        const ok = systemPreferences.isTrustedAccessibilityClient(true);
        return ok ? 'granted' : 'not_determined';
      }
      case 'notifications':
        return 'granted';
    }
  }

  /** Open the Privacy pane scoped to `kind`. No-op if there's no deep link. */
  async openSystemSettings(kind: PermissionKind): Promise<void> {
    const url = PRIVACY_DEEP_LINKS[kind];
    if (!url) return;
    await shell.openExternal(url);
  }
}
