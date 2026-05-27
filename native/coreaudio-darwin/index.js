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
  const listeners = {
    pcm: new Set(),
    deviceChange: new Set(),
    rebound: new Set(),
    error: new Set(),
  };
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
  inner.setOnRebound(() => {
    for (const cb of listeners.rebound) cb();
  });

  return {
    /** Begin capture. AUHAL starts synchronously; throws on error.
     *  `opts.deviceId` empty string / undefined = auto-detect (system
     *  default with live re-bind on system-default change). Any UID = pinned
     *  (no auto-switch; emits 'error' with message='device_disappeared' if
     *  the pinned device goes away). */
    async start(opts) {
      const deviceId = opts && typeof opts.deviceId === 'string' ? opts.deviceId : '';
      inner.start(deviceId);
    },
    /** Stop capture + dispose the audio unit. */
    async stop() {
      inner.stop();
    },
    /** Mid-session device switch. Empty string = back to auto-detect. */
    setDevice(deviceId) {
      inner.setDevice(typeof deviceId === 'string' ? deviceId : '');
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
  // 'tap_lost' fires when the native callback determined the CGEventTap is
  // dead — either because macOS revoked Accessibility (UserInput subtype)
  // or because we tripped the re-enable rate-limit (Timeout subtype with
  // trust missing or storm). The JS-side manager treats this as "mark
  // uninstalled and re-arm the trust poll." Without a listener attached
  // the event is silently dropped; native still tears the tap down.
  const listeners = { press: new Set(), release: new Set(), tap_lost: new Set() };
  inner.setOnPress(() => {
    for (const cb of listeners.press) cb();
  });
  inner.setOnRelease(() => {
    for (const cb of listeners.release) cb();
  });
  if (typeof inner.setOnTapLost === 'function') {
    inner.setOnTapLost(() => {
      for (const cb of listeners.tap_lost) cb();
    });
  }
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

/**
 * Synthesize a Cmd+V keystroke at the system event tap. Returns true on
 * success, false if the addon is missing the export or the underlying call
 * couldn't post events. Requires macOS Accessibility permission (same grant
 * the Globe-key tap uses); without it, CGEventPost silently no-ops and we
 * still return true — callers should treat that as "trusted to post, OS may
 * or may not have delivered" and rely on the Accessibility check upstream.
 */
function pasteCommandV() {
  if (typeof native.pasteCommandV !== 'function') return false;
  try {
    return Boolean(native.pasteCommandV());
  } catch (_) {
    return false;
  }
}

/**
 * Read/write the macOS "Press 🌐 key to:" preference (`AppleFnUsageType` in
 * NSGlobalDomain). Values: 0=Do Nothing, 1=Emoji & Symbols, 2=Change Input
 * Source, 3=Start Dictation. TwinMind wants 0 so the emoji panel never
 * races our CGEventTap.
 */
function fnUsageType() {
  return {
    get() {
      if (typeof native.getFnUsageType !== 'function') return null;
      try {
        const v = native.getFnUsageType();
        return typeof v === 'number' ? v : null;
      } catch (_) {
        return null;
      }
    },
    set(value) {
      if (typeof native.setFnUsageType !== 'function') return false;
      try {
        return Boolean(native.setFnUsageType(Number(value)));
      } catch (_) {
        return false;
      }
    },
  };
}

/**
 * Query the macOS TCC state for kTCCServiceAudioCapture (the
 * NSAudioCaptureUsageDescription permission used by Core Audio Taps).
 * Synchronous, side-effect-free — safe to call while audiotee is recording.
 * Returns one of: 'authorized' | 'denied' | 'not_determined' | 'unavailable'.
 * 'unavailable' covers the future-macOS case where the private TCC symbol is
 * missing; callers should treat it like 'not_determined' for UI purposes.
 */
function audioCapturePreflight() {
  if (typeof native.audioCapturePreflight !== 'function') return 'unavailable';
  try {
    const v = native.audioCapturePreflight();
    return typeof v === 'string' ? v : 'unavailable';
  } catch (_) {
    return 'unavailable';
  }
}

/**
 * Trigger the OS prompt for audio-capture if state is not_determined; resolve
 * with the current grant otherwise. Resolves with one of:
 * 'authorized' | 'denied' | 'unavailable'. Never throws.
 */
function audioCaptureRequest() {
  if (typeof native.audioCaptureRequest !== 'function') {
    return Promise.resolve('unavailable');
  }
  try {
    return Promise.resolve(native.audioCaptureRequest()).catch(() => 'unavailable');
  } catch (_) {
    return Promise.resolve('unavailable');
  }
}

module.exports = {
  micCapture,
  micMonitor,
  deviceMonitor,
  listInputDevices,
  globeKey,
  pasteCommandV,
  fnUsageType,
  audioCapturePreflight,
  audioCaptureRequest,
};
