// TccAudioCapture.mm — Introspect / request kTCCServiceAudioCapture.
//
// macOS gives us no public API to query NSAudioCaptureUsageDescription state.
// AVCaptureDevice.authorizationStatus covers the microphone but not the
// Core-Audio-Taps service introduced in 14.2. The private TCC framework does
// expose it via TCCAccessPreflight / TCCAccessRequest, which is the same path
// AudioCap (https://github.com/insidegui/AudioCap) and similar reference
// projects use.
//
// We load the framework dynamically so a future macOS that removes or renames
// these symbols degrades to "unavailable" instead of failing to load the
// addon. Function pointers are cached after first lookup.
//
// Notes:
//   * Preflight is synchronous, side-effect-free, microsecond-level — safe
//     to call from any thread, including while audiotee is actively running.
//   * Request triggers the OS prompt when state is not_determined; otherwise
//     it resolves with the current grant without surfacing UI. It hops to a
//     background queue so we never block the Node event loop.
//   * Private SPIs: acceptable for direct-distribution apps. Not allowed for
//     Mac App Store submissions; TwinMind ships via DMG + Developer ID.

#include <napi.h>
#import <Foundation/Foundation.h>
#include <dispatch/dispatch.h>
#include <dlfcn.h>

namespace {

// TCC return codes for TCCAccessPreflight.
constexpr int kTccAuthorized = 0;
constexpr int kTccDenied = 1;
constexpr int kTccNotDetermined = 2;

typedef int (*TCCAccessPreflightFn)(CFStringRef service, CFDictionaryRef options);
typedef void (*TCCAccessRequestFn)(CFStringRef service, CFDictionaryRef options,
                                   void (^completion)(BOOL granted));

struct TccSymbols {
  TCCAccessPreflightFn preflight = nullptr;
  TCCAccessRequestFn request = nullptr;
  bool resolved = false;
};

// Resolve once, cache forever. dlopen on an already-loaded image is cheap and
// reference-counted; we never dlclose because TCC.framework is part of the
// shared cache and other system frameworks may depend on it.
static const TccSymbols &ResolveTcc() {
  static TccSymbols syms;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    void *h = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_LAZY);
    if (!h) return;
    syms.preflight = (TCCAccessPreflightFn)dlsym(h, "TCCAccessPreflight");
    syms.request = (TCCAccessRequestFn)dlsym(h, "TCCAccessRequest");
    syms.resolved = (syms.preflight != nullptr && syms.request != nullptr);
  });
  return syms;
}

// Map TCC code → our PermissionGrant strings. Anything we don't recognize
// (including a missing TCC framework on a future macOS) becomes 'unavailable'
// so the UI can show a sensible fallback instead of a hard error.
static const char *GrantStringFromTccCode(int code) {
  switch (code) {
    case kTccAuthorized: return "authorized";
    case kTccDenied: return "denied";
    case kTccNotDetermined: return "not_determined";
    default: return "unavailable";
  }
}

}  // namespace

// audioCapturePreflight() — synchronous TCC database lookup.
// Returns one of: 'authorized' | 'denied' | 'not_determined' | 'unavailable'.
static Napi::Value AudioCapturePreflight(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  const TccSymbols &syms = ResolveTcc();
  if (!syms.resolved || !syms.preflight) {
    return Napi::String::New(env, "unavailable");
  }
  int code = syms.preflight(CFSTR("kTCCServiceAudioCapture"), NULL);
  return Napi::String::New(env, GrantStringFromTccCode(code));
}

// audioCaptureRequest() — async; returns a Promise that resolves with one of:
// 'authorized' | 'denied' | 'unavailable'. Fires the OS prompt when state is
// not_determined; otherwise resolves immediately with the current grant.
//
// Implementation: TCCAccessRequest invokes its completion block on an internal
// queue when the user dismisses the prompt. We bridge that back to the Node
// thread via a ThreadSafeFunction. The completion only tells us granted/not,
// so we re-preflight inside the completion to distinguish denied from
// unavailable (the latter shouldn't happen at this point but keep the
// vocabulary consistent).
static Napi::Value AudioCaptureRequest(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);

  const TccSymbols &syms = ResolveTcc();
  if (!syms.resolved || !syms.request) {
    deferred.Resolve(Napi::String::New(env, "unavailable"));
    return deferred.Promise();
  }

  // Shared box so the completion block can hand the result back to the TSFN
  // callback running on the Node thread.
  auto resultBox = std::make_shared<std::string>();

  // Build a TSFN that, when invoked, reads *resultBox and resolves the
  // Promise. We use a non-finalize-allocating callback (no JS args needed at
  // call time). MaxQueue = 1, InitialThreadCount = 1.
  auto tsfn = Napi::ThreadSafeFunction::New(
      env,
      Napi::Function::New(env, [deferred, resultBox](const Napi::CallbackInfo &cbInfo) {
        Napi::Env cbEnv = cbInfo.Env();
        deferred.Resolve(Napi::String::New(cbEnv, *resultBox));
      }),
      "tcc_audio_capture_request",
      0,  // unlimited queue (we'll call once)
      1);

  // Hand off to TCC. The completion block may run on an arbitrary background
  // queue — never the Node thread — so we MUST use the TSFN to hop back.
  syms.request(CFSTR("kTCCServiceAudioCapture"), NULL, ^(BOOL granted) {
    if (granted) {
      *resultBox = "authorized";
    } else {
      // Re-preflight to distinguish denied (user said no) from the unlikely
      // unavailable case. Cheap; same lookup we do for the read path.
      const TccSymbols &s = ResolveTcc();
      int code = (s.preflight ? s.preflight(CFSTR("kTCCServiceAudioCapture"), NULL) : -1);
      *resultBox = (code == kTccAuthorized ? "authorized"
                    : code == kTccDenied ? "denied"
                    : code == kTccNotDetermined ? "denied"  // user dismissed
                    : "unavailable");
    }
    tsfn.BlockingCall();
    tsfn.Release();
  });

  return deferred.Promise();
}

Napi::Object InitTccAudioCapture(Napi::Env env, Napi::Object exports) {
  exports.Set("audioCapturePreflight", Napi::Function::New(env, AudioCapturePreflight));
  exports.Set("audioCaptureRequest", Napi::Function::New(env, AudioCaptureRequest));
  return exports;
}
