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
      ...(spec.closeButtonText ? { closeButtonText: spec.closeButtonText } : {}),
    };

    // Constructor failures rethrow with a "stage" label so the caller's catch
    // block can distinguish constructor failure from show() failure in logs —
    // the two stages have different root causes (constructor: API
    // unavailable / bad options; show: OS permission denied / notification
    // center unreachable).
    let n: Notification;
    try {
      n = new Notification(options);
    } catch (err) {
      throw new Error(
        `notification constructor failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // `close` fires for BOTH the auto-dismiss timer and a user clicking the
    // close button — distinguish them by tracking which path closed it.
    let closedByTimer = false;
    let closedByApi = false;

    // Map Electron's response events back into the action-id contract.
    n.on('action', (_event, index) => {
      const action = spec.actions?.[index];
      if (action) onAction(action.id);
    });
    n.on('click', () => onAction('__body__'));
    n.on('close', () => {
      if (closedByApi) return; // programmatic close (caller dismissed it)
      onAction(closedByTimer ? '__timed_out__' : '__close__');
    });

    try {
      n.show();
    } catch (err) {
      throw new Error(
        `notification show() failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let timer: NodeJS.Timeout | null = null;
    if (spec.autoDismissMs) {
      timer = setTimeout(() => {
        closedByTimer = true;
        n.close();
      }, spec.autoDismissMs);
    }

    return {
      close() {
        if (timer) clearTimeout(timer);
        closedByApi = true;
        n.close();
      },
    };
  }
}
