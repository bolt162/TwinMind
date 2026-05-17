/**
 * DarwinPermissionService — macOS TCC permission checks + prompts.
 *
 * Architecture: §12.5 (permissions matrix), §16.1 (onboarding flow).
 *
 * The four permissions we care about:
 *   - mic           → `systemPreferences.getMediaAccessStatus('microphone')`
 *   - audioCapture  → `systemPreferences.getMediaAccessStatus('audio-capture')` (mac 14.2+)
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
      case 'audioCapture':
        // Electron 36's `getMediaAccessStatus` only knows microphone/camera/screen.
        // macOS 14.2's NSAudioCaptureUsageDescription has no introspection API;
        // the OS only triggers the prompt when an audiotee capture starts. We
        // report `not_determined` until that happens.
        return 'not_determined';
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
        // No Electron API for this — the OS triggers the prompt only when
        // audiotee starts capturing system audio. Onboarding's "Check / Request"
        // button is therefore informational; the actual grant happens at first
        // meeting start.
        return 'not_determined';
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
