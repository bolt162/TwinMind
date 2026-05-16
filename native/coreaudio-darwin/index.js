// JS adapter for the C++ addon. Wraps `MicCapture` / `MicMonitor` into the
// ICapture / IMicActivityMonitor shapes consumed by audio-process and main.
//
// We use CommonJS here because node-gyp output is always CJS; the consuming
// audio-process loads this via `require()`.

'use strict';

let native;
try {
  // The .node binary is compiled into build/Release/ by node-gyp install.
  native = require('./build/Release/coreaudio_darwin.node');
} catch (err) {
  // Distinguish "not built" from "built for the wrong ABI/arch" — different
  // fix on the user side. dlopen reports arch mismatch in the message; the
  // ENOENT case happens before that.
  const msg = err && err.message ? String(err.message) : '';
  if (msg.includes('incompatible architecture') || msg.includes('NODE_MODULE_VERSION')) {
    throw new Error(
      'coreaudio_darwin: native binary is built for the wrong runtime ' +
        '(arch or Node ABI mismatch). Run `npm run switch:app` to rebuild ' +
        'for Electron, or `npm run switch:tests` to rebuild for host Node.\n' +
        'Underlying: ' + msg,
    );
  }
  throw new Error(
    'coreaudio_darwin: native binary not found. ' +
      'Run `npm install` in native/coreaudio-darwin/, or `npm run rebuild` after a clean.\n' +
      'Underlying: ' + msg,
  );
}

/** Build an ICapture-shaped mic capture object. */
function micCapture() {
  const inner = new native.MicCapture();
  const listeners = { pcm: new Set(), deviceChange: new Set(), error: new Set() };
  let pcmErrLogged = false;

  // Wire each native callback into our listener fan-out. Listeners can attach
  // after start() because we set the callbacks unconditionally below.
  inner.setOnPcm((buf) => {
    try {
      for (const cb of listeners.pcm) cb(buf, process.hrtime.bigint());
    } catch (e) {
      // Without this catch, an exception here becomes a DEP0168 "uncaught
      // N-API callback exception" warning with NO stack — and every PCM
      // frame is silently dropped. Surface the first error so a regression
      // (e.g., another future Node-API ABI change) doesn't go unnoticed.
      if (!pcmErrLogged) {
        pcmErrLogged = true;
        process.stderr.write(
          `[coreaudio-darwin] PCM listener threw: ${e && e.message}\n${e && e.stack}\n`,
        );
      }
    }
  });
  inner.setOnError((msg) => {
    const err = new Error(String(msg));
    for (const cb of listeners.error) cb(err);
  });
  inner.setOnDeviceChange((info) => {
    for (const cb of listeners.deviceChange) cb({ label: (info && info.label) || null });
  });

  return {
    /** Begin capture. AVAudioEngine starts synchronously; rejects on error.
     *  Honors `opts.deviceId` (CoreAudio device UID); falls back to system
     *  default when omitted or when the device can't be resolved. */
    async start(opts) {
      const deviceId = opts && typeof opts.deviceId === 'string' ? opts.deviceId : '';
      inner.start(deviceId);
    },
    /** Stop capture and remove the engine tap. */
    async stop() {
      inner.stop();
    },
    /** Typed subscribe; returns unsubscribe. */
    on(event, listener) {
      const set = listeners[event];
      if (!set) throw new Error(`unknown event: ${event}`);
      set.add(listener);
      return () => set.delete(listener);
    },
  };
}

/** Build an IMicActivityMonitor-shaped monitor object. */
function micMonitor() {
  const inner = new native.MicMonitor();
  const listeners = { started: new Set(), stopped: new Set() };
  inner.setOnStarted(() => {
    for (const cb of listeners.started) cb();
  });
  inner.setOnStopped(() => {
    for (const cb of listeners.stopped) cb();
  });
  return {
    start() {
      inner.start();
    },
    stop() {
      inner.stop();
    },
    on(event, listener) {
      const set = listeners[event];
      if (!set) throw new Error(`unknown event: ${event}`);
      set.add(listener);
      return () => set.delete(listener);
    },
  };
}

/**
 * Build a default-input device-change monitor. Fires `change` with
 * { label, kind, noDevice } whenever the OS default input flips.
 */
function deviceMonitor() {
  const inner = new native.DeviceChangeMonitor();
  const listeners = { change: new Set() };
  inner.setOnChange((info) => {
    for (const cb of listeners.change) cb(info);
  });
  return {
    start() {
      inner.start();
    },
    stop() {
      inner.stop();
    },
    on(event, listener) {
      const set = listeners[event];
      if (!set) throw new Error(`unknown event: ${event}`);
      set.add(listener);
      return () => set.delete(listener);
    },
  };
}

/** Enumerate CoreAudio input devices. Returns an array of
 *  { id (UID string), name, isDefault }. Use the `id` field as the
 *  `deviceId` in CaptureStartOptions to pin a specific device. */
function listInputDevices() {
  if (typeof native.listInputDevices !== 'function') return [];
  try {
    return native.listInputDevices();
  } catch (_) {
    return [];
  }
}

/**
 * Build a Globe/Fn-key listener. Returns { start, stop, on } where start()
 * returns true iff the CGEventTap was created — false means macOS
 * Accessibility permission is missing. Call start() again after the user
 * grants permission; no need to recreate the instance.
 */
function globeKey() {
  const inner = new native.GlobeKey();
  const listeners = { press: new Set(), release: new Set() };
  inner.setOnPress(() => {
    for (const cb of listeners.press) cb();
  });
  inner.setOnRelease(() => {
    for (const cb of listeners.release) cb();
  });
  return {
    /** Install the CGEventTap. Returns true on success, false if Accessibility
     *  permission is missing. Idempotent while already running. */
    start() {
      return Boolean(inner.start());
    },
    stop() {
      inner.stop();
    },
    on(event, listener) {
      const set = listeners[event];
      if (!set) throw new Error(`unknown event: ${event}`);
      set.add(listener);
      return () => set.delete(listener);
    },
  };
}

module.exports = { micCapture, micMonitor, deviceMonitor, listInputDevices, globeKey };
