/**
 * DarwinNotificationService — Electron Notification wrapper.
 *
 * Architecture: §5 (INotificationService), §8.4 (meeting auto-detect UX:
 * title "Recording detected", body "Start a meeting note?", actions
 * "Start recording" / "Not now").
 *
 * Electron's Notification supports `actions` only on macOS via the
 * `actions` array (each item is `{ type: 'button', text: string }`). The
 * native UNUserNotificationCenter surfaces those as the response buttons.
 */

import { Notification, type NotificationConstructorOptions } from 'electron';
import type {
  INotificationService,
  NotificationHandle,
  NotificationSpec,
} from '../INotificationService';

export class DarwinNotificationService implements INotificationService {
  /** Show a native notification; resolve the callback when the user acts on it. */
  show(spec: NotificationSpec, onAction: (actionId: string) => void): NotificationHandle {
    const options: NotificationConstructorOptions = {
      title: spec.title,
      body: spec.body,
      silent: true, // architecture §8.4: "No sound"
      actions: (spec.actions ?? []).map((a) => ({ type: 'button', text: a.label })),
    };
    const n = new Notification(options);

    // Map Electron's response events back into the action-id contract.
    // `n.on('action', (_e, idx))` fires when the user clicks one of the buttons.
    n.on('action', (_event, index) => {
      const action = spec.actions?.[index];
      if (action) onAction(action.id);
    });
    // Body click → main app surface.
    n.on('click', () => onAction('__body__'));
    n.on('close', () => onAction('__dismissed__'));

    n.show();

    // Auto-dismiss after the configured timeout (architecture §8.4: 60 s).
    let timer: NodeJS.Timeout | null = null;
    if (spec.autoDismissMs) {
      timer = setTimeout(() => n.close(), spec.autoDismissMs);
    }

    return {
      close() {
        if (timer) clearTimeout(timer);
        n.close();
      },
    };
  }
}
