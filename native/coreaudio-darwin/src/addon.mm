// addon.mm — N-API entry point.
//
// Architecture: §7.1 (mic capture), §8.1 (mic activity).
//
// Two exports:
//   - micCaptureCreate()  → returns an object with start/stop and onPcm/onError/onDeviceChange
//   - micMonitorCreate()  → returns an object with start/stop and onStarted/onStopped
// The JS adapter in index.js wraps these to match the ICapture / IMicActivityMonitor
// shapes consumed by audio-process.

#include <napi.h>

extern Napi::Object InitMicCapture(Napi::Env env, Napi::Object exports);
extern Napi::Object InitMicMonitor(Napi::Env env, Napi::Object exports);
extern Napi::Object InitDeviceChangeMonitor(Napi::Env env, Napi::Object exports);
extern Napi::Object InitGlobeKey(Napi::Env env, Napi::Object exports);

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  InitMicCapture(env, exports);
  InitMicMonitor(env, exports);
  InitDeviceChangeMonitor(env, exports);
  InitGlobeKey(env, exports);
  return exports;
}

NODE_API_MODULE(coreaudio_darwin, Init)
