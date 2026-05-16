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
   * Display a notification. The callback fires with the chosen action's id
   * (or `'__body__'` if the user clicked the body, `'__dismissed__'` on
   * timeout / explicit dismiss).
   */
  show(spec: NotificationSpec, onAction: (actionId: string) => void): NotificationHandle;
}
