/**
 * IGlobeKeyManager — Fn/Globe key press-release events.
 *
 * Architecture: §5 (composite hotkey source). The Globe key isn't reachable
 * by `electron.globalShortcut` or `uiohook-napi`; only a CGEventTap can see
 * it without the OS swallowing it for the emoji panel.
 *
 * Implementations:
 *   - darwin: in-process CGEventTap via the `@twinmind/coreaudio-darwin`
 *     native addon (see DarwinGlobeKeyManager). Subject to the app's
 *     Accessibility grant — no separate TCC entry.
 *   - win32: not applicable (Windows has no Globe key). Service is `undefined`
 *     on PlatformServices for non-Darwin.
 */

export interface IGlobeKeyManager {
  /** Install the listener. Idempotent; safe to call again after the user
   *  grants Accessibility permission. */
  start(): void;
  /** Tear down the listener and clear handlers. Called on app quit. */
  stop(): void;
  /** Subscribe to "Fn pressed". Returns an unsubscribe. */
  onPress(handler: () => void): () => void;
  /** Subscribe to "Fn released". Returns an unsubscribe. */
  onRelease(handler: () => void): () => void;
}
