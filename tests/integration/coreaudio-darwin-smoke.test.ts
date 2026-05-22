/**
 * Surface-level smoke tests for `@twinmind/coreaudio-darwin`.
 *
 * Scope intentionally narrow: confirm the native binary loads, the JS
 * adapter (index.js) exposes everything index.d.ts declares, and the
 * surface methods can be poked at without triggering microphone /
 * accessibility permission prompts or actually opening real audio
 * hardware.
 *
 * What these will catch:
 *   - .node binary missing or built for the wrong ABI/arch
 *   - JS-adapter exports drifting from index.d.ts
 *   - `setOnXxx` wiring in the C++ addon getting renamed without the
 *     adapter being updated (object surface throws on construction)
 *   - The synchronous "bogus UID → device_disappeared" guard in
 *     MicCapture::Start regressing (it's the one error path callers
 *     rely on to know a pinned device went away pre-AUHAL)
 *
 * What these will NOT catch:
 *   - PCM frame-format regressions, silence-fill watchdog bugs,
 *     mic-rebound race conditions — those need real AUHAL + hardware.
 *
 * Guards:
 *   - Skipped on non-darwin (the addon's package.json declares
 *     "os": ["darwin"]; require() would dlopen-fail).
 *   - Skipped silently when node_modules/.twinmind-native-abi !== 'tests'
 *     — the repo convention is `npm run switch:tests` before running
 *     vitest; without it the .node is built for Electron's ABI and
 *     require()-ing it throws NODE_MODULE_VERSION mismatch.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const IS_DARWIN = process.platform === 'darwin';
const ABI_MARKER = path.resolve(__dirname, '../../node_modules/.twinmind-native-abi');
const ABI_OK =
  IS_DARWIN &&
  fs.existsSync(ABI_MARKER) &&
  fs.readFileSync(ABI_MARKER, 'utf8').trim() === 'tests';

const describeNative = ABI_OK ? describe : describe.skip;

describeNative('coreaudio-darwin: smoke', () => {
  // Lazy-require so the file can be collected on non-darwin / wrong-ABI
  // runners without throwing at import time. Top-level `import` would
  // fail before describe.skip could short-circuit.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const native = require('@twinmind/coreaudio-darwin') as typeof import('@twinmind/coreaudio-darwin');

  // ─── module load + exports ───────────────────────────────────────────

  it('module loads via require() without throwing', () => {
    expect(native).toBeDefined();
  });

  it('exposes every factory declared in index.d.ts', () => {
    expect(typeof native.micCapture).toBe('function');
    expect(typeof native.micMonitor).toBe('function');
    expect(typeof native.deviceMonitor).toBe('function');
    expect(typeof native.listInputDevices).toBe('function');
    expect(typeof native.globeKey).toBe('function');
    expect(typeof native.pasteCommandV).toBe('function');
    expect(typeof native.fnUsageType).toBe('function');
  });

  // ─── listInputDevices ────────────────────────────────────────────────

  it('listInputDevices() returns an array', () => {
    const devices = native.listInputDevices();
    expect(Array.isArray(devices)).toBe(true);
  });

  it('listInputDevices() entries (when present) have the documented shape', () => {
    const devices = native.listInputDevices();
    // CI runners may not enumerate audio devices — empty is acceptable.
    if (devices.length === 0) return;
    const validKinds = new Set(['built_in', 'bluetooth', 'usb', 'other']);
    let defaultCount = 0;
    for (const d of devices) {
      expect(typeof d.id).toBe('string');
      expect(d.id.length).toBeGreaterThan(0);
      expect(typeof d.name).toBe('string');
      expect(typeof d.isDefault).toBe('boolean');
      expect(validKinds.has(d.kind)).toBe(true);
      if (d.isDefault) defaultCount += 1;
    }
    // CoreAudio invariant: at most one default-input device at a time.
    expect(defaultCount).toBeLessThanOrEqual(1);
  });

  // ─── micCapture: surface + bogus-UID + reusable-after-fail ──────────

  it('micCapture() returns an object exposing start/stop/setDevice/on', () => {
    const mic = native.micCapture();
    expect(typeof mic.start).toBe('function');
    expect(typeof mic.stop).toBe('function');
    expect(typeof mic.setDevice).toBe('function');
    expect(typeof mic.on).toBe('function');
  });

  it("micCapture().on('bogus_event') throws (adapter rejects unknown events)", () => {
    const mic = native.micCapture();
    // The JS adapter (native/coreaudio-darwin/index.js) maps event names
    // to internal Sets; unknown names throw with `unknown event: …`.
    expect(() => mic.on('bogus_event' as 'pcm', () => {})).toThrow(/unknown event/);
  });

  it("micCapture().on('pcm', cb) returns an unsubscribe function", () => {
    const mic = native.micCapture();
    const unsub = mic.on('pcm', () => {});
    expect(typeof unsub).toBe('function');
    // Calling it shouldn't throw; idempotent.
    expect(() => unsub()).not.toThrow();
    expect(() => unsub()).not.toThrow();
  });

  it('micCapture().start(bogusUid) rejects with device_disappeared (pre-AUHAL, no permission prompt)', async () => {
    const mic = native.micCapture();
    // MicCapture::Start resolves UID → kAudioObjectUnknown → throws
    // synchronously BEFORE OpenAndStartUnit is reached, so this path
    // never opens the audio unit and never triggers macOS's mic
    // permission flow.
    await expect(mic.start({ deviceId: 'no-such-device-uid-zzz-12345' })).rejects.toThrow(
      /device_disappeared/i,
    );
  });

  it('micCapture is reusable after a failed start (no zombie state)', async () => {
    const mic = native.micCapture();
    await expect(mic.start({ deviceId: 'bogus-first-attempt' })).rejects.toThrow(
      /device_disappeared/i,
    );
    // A second start with a different (still bogus) UID should also reject
    // cleanly — i.e., the previous failure didn't leave the object in a
    // state that errors at the JS-adapter layer or throws a different message.
    await expect(mic.start({ deviceId: 'bogus-second-attempt' })).rejects.toThrow(
      /device_disappeared/i,
    );
  });

  // ─── micMonitor: start/stop cycle ────────────────────────────────────

  it('micMonitor().start() + stop() cycle does not throw', () => {
    const mon = native.micMonitor();
    // Uses kAudioDevicePropertyDeviceIsRunningSomewhere — system-info
    // listener, no permission gate, no audio unit opened.
    expect(() => mon.start()).not.toThrow();
    expect(() => mon.stop()).not.toThrow();
    // Idempotent re-stop.
    expect(() => mon.stop()).not.toThrow();
  });

  // ─── deviceMonitor: start/stop cycle ─────────────────────────────────

  it('deviceMonitor().start() + stop() cycle does not throw', () => {
    const mon = native.deviceMonitor();
    // Listens to kAudioHardwarePropertyDefaultInputDevice — also
    // permission-free.
    expect(() => mon.start()).not.toThrow();
    expect(() => mon.stop()).not.toThrow();
    expect(() => mon.stop()).not.toThrow();
  });

  // ─── globeKey: surface only ──────────────────────────────────────────

  it('globeKey() returns an object exposing start/stop/on (NOT started here)', () => {
    // We DELIBERATELY do not call start() — it installs a system-wide
    // CGEventTap that intercepts every keypress (when Accessibility is
    // granted) or returns false silently (when it isn't). Either way,
    // not what we want running in a test process. Surface check only.
    const gk = native.globeKey();
    expect(typeof gk.start).toBe('function');
    expect(typeof gk.stop).toBe('function');
    expect(typeof gk.on).toBe('function');
  });

  // ─── fnUsageType: read-only ──────────────────────────────────────────

  it('fnUsageType().get() returns number | null without throwing', () => {
    // We do NOT call set() — that would mutate the user's actual
    // NSGlobalDomain AppleFnUsageType preference.
    const fn = native.fnUsageType();
    const value = fn.get();
    expect(value === null || typeof value === 'number').toBe(true);
  });

  // ─── pasteCommandV: existence only ───────────────────────────────────

  it('pasteCommandV is a function (NOT invoked — would synthesize a real Cmd+V)', () => {
    // Calling this would post a Cmd+V to whatever app currently has focus
    // — could corrupt arbitrary state on the test runner. Surface only.
    expect(typeof native.pasteCommandV).toBe('function');
  });
});
