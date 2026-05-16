/**
 * IPermissionService — OS-level capability state.
 *
 * Architecture: §5 (PermissionService), §12.5 (permissions matrix), §16.1
 * (onboarding flow).
 *
 * Per the matrix, the four capabilities the app cares about are:
 *   - mic           : NSMicrophoneUsageDescription on mac; same on win
 *   - audioCapture  : NSAudioCaptureUsageDescription (mac 14.2+); no-op on win
 *   - accessibility : NSAccessibilityUsageDescription on mac; no-op on win
 *   - notifications : UNUserNotificationCenter / ToastNotificationManager
 *
 * The service exposes read + request methods. Read is synchronous and cheap;
 * request opens the system prompt and resolves with the resulting grant.
 */

export type PermissionKind = 'mic' | 'audioCapture' | 'accessibility' | 'notifications';

export type PermissionGrant = 'granted' | 'denied' | 'not_determined' | 'unavailable';

export interface IPermissionService {
  /** Sync snapshot of one permission's current state. */
  read(kind: PermissionKind): PermissionGrant;

  /**
   * Prompt the user for a permission. On macOS, this triggers the system
   * dialog if the state is `not_determined`; otherwise it returns the current
   * grant without surfacing UI.
   */
  request(kind: PermissionKind): Promise<PermissionGrant>;

  /** Open the OS Privacy & Security pane for the given capability (deep link). */
  openSystemSettings(kind: PermissionKind): Promise<void>;
}
