/**
 * INotificationService — show/dismiss native OS notifications.
 *
 * Architecture: §5 (INotificationService), §8.4 (meeting auto-detect UX).
 */

export interface NotificationActionDef {
  /** Stable id forwarded to `onClick(actionId)`. */
  readonly id: string;
  /** User-facing button label. */
  readonly label: string;
}

export interface NotificationSpec {
  readonly title: string;
  readonly body: string;
  /** Optional action buttons rendered on the notification. */
  readonly actions?: ReadonlyArray<NotificationActionDef>;
  /**
   * macOS only — replaces the default close ("X") button with a labelled
   * button. Useful when you want a visible secondary action without burying
   * it inside the Options dropdown.
   *
   * Clicks fire the `__close__` action id (distinguishable from auto-dismiss
   * which fires `__timed_out__`).
   */
  readonly closeButtonText?: string;
  /** Auto-dismiss after this many ms. Default: OS-determined. */
  readonly autoDismissMs?: number;
  /** Optional tag so a subsequent show() with the same tag replaces the old. */
  readonly tag?: string;
}

export interface NotificationHandle {
  /** Close the notification programmatically. */
  close(): void;
}

export interface INotificationService {
  /**
   * Display a notification. The callback fires with the chosen action's id,
   * or one of the sentinel ids:
   *   `'__body__'`      — user clicked the notification body
   *   `'__close__'`     — user clicked the labelled close button (closeButtonText)
   *   `'__timed_out__'` — autoDismissMs expired without user action
   */
  show(spec: NotificationSpec, onAction: (actionId: string) => void): NotificationHandle;
}
