/**
 * IDeviceMonitor — default-input device changes, route changes, Bluetooth state.
 *
 * Architecture: §5 (IDeviceMonitor), §7.7 (device-change recovery). The
 * orchestrator listens here and uses events to force a chunk boundary
 * (`device_boundary=1`) so the upload queue can reason about discontinuities.
 */

export type DeviceKind = 'built_in' | 'bluetooth' | 'usb' | 'other';

export interface DeviceChange {
  /** Coarse classification; the label is informational only. */
  readonly kind: DeviceKind;
  /** Best-effort human label ("MacBook Pro Mic", "AirPods Pro"). May be null. */
  readonly label: string | null;
  /** True if the new default appears to have *no* input device available. */
  readonly noDevice: boolean;
}

export interface IDeviceMonitor {
  start(): void;
  stop(): void;
  /** Subscribe to default-input device-change events. Returns unsubscribe. */
  onChange(cb: (change: DeviceChange) => void): () => void;
}
