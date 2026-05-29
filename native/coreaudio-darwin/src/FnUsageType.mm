// FnUsageType.mm — Read/write the macOS "Press 🌐 key to:" preference.
//
// `AppleFnUsageType` in NSGlobalDomain controls what macOS does when the
// user presses Fn (no other key). Values:
//   0 = Do Nothing
//   1 = Show Emoji & Symbols   (the macOS default)
//   2 = Change Input Source
//   3 = Start Dictation
//
// TwinMind needs this set to 0 so the OS doesn't try to open the emoji
// picker mid-hotkey-press. Our CGEventTap can swallow Fn flagsChanged in
// *most* cases, but under sustained load (audio-process running, meeting
// mode active, chunk uploads churning) it occasionally loses the race and
// the OS pops the panel. Setting the preference to 0 makes the OS not even
// try — the race disappears entirely.
//
// We write BOTH preference domains, because they serve different consumers and
// macOS versions disagree on which one is authoritative:
//   • NSGlobalDomain (`kCFPreferencesAnyApplication`, i.e.
//     `~/Library/Preferences/.GlobalPreferences.plist`) — the domain macOS 26
//     reads for the LIVE globe/emoji behavior. This is the one that actually
//     suppresses the panel. (An earlier comment here called this "a ghost key
//     that nothing reads"; that was wrong for macOS 26 — confirmed on a fresh
//     machine where HIToolbox=0 but this key was unset and the panel still
//     popped. Writing only HIToolbox updates the UI display without changing
//     behavior.)
//   • com.apple.HIToolbox — what System Settings → Keyboard *displays*. Kept
//     in sync so the UI matches the live behavior.
// Reads use NSGlobalDomain (the live-controlling domain) so callers can tell
// when it still needs to be set even if HIToolbox already reads 0.

#include <napi.h>
#import <Foundation/Foundation.h>
#include <notify.h>

#define kFnUsageKey CFSTR("AppleFnUsageType")
#define kFnUsageHIToolboxDomain CFSTR("com.apple.HIToolbox")
// NSGlobalDomain (.GlobalPreferences) — the live-controlling domain on macOS 26.
#define kFnUsageGlobalDomain kCFPreferencesAnyApplication

// Returns the current AppleFnUsageType from the LIVE domain (NSGlobalDomain) as
// a Number, or null if unset (in which case the OS behaves as if it were 1).
// We deliberately read NSGlobalDomain, NOT HIToolbox: HIToolbox can read 0
// while NSGlobalDomain is unset (the fresh-install case where the panel still
// pops), and returning 0 there would make the caller think no write is needed.
static Napi::Value GetFnUsageType(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  CFPropertyListRef val = CFPreferencesCopyAppValue(kFnUsageKey, kFnUsageGlobalDomain);
  if (!val) return env.Null();

  int32_t out = -1;
  if (CFGetTypeID(val) == CFNumberGetTypeID()) {
    CFNumberGetValue((CFNumberRef)val, kCFNumberSInt32Type, &out);
  }
  CFRelease(val);
  if (out < 0) return env.Null();
  return Napi::Number::New(env, out);
}

// Persist `value` to BOTH NSGlobalDomain (live behavior) and com.apple.HIToolbox
// (Settings display), then nudge the input subsystem to reload. Returns true
// only if both domains synchronized successfully.
static Napi::Value SetFnUsageType(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    return Napi::Boolean::New(env, false);
  }
  int32_t value = info[0].As<Napi::Number>().Int32Value();

  CFNumberRef num = CFNumberCreate(NULL, kCFNumberSInt32Type, &value);
  if (!num) return Napi::Boolean::New(env, false);

  // Live behavior (NSGlobalDomain) first, then the Settings-display mirror.
  CFPreferencesSetAppValue(kFnUsageKey, num, kFnUsageGlobalDomain);
  CFPreferencesSetAppValue(kFnUsageKey, num, kFnUsageHIToolboxDomain);
  CFRelease(num);

  Boolean okGlobal = CFPreferencesAppSynchronize(kFnUsageGlobalDomain);
  Boolean okHIToolbox = CFPreferencesAppSynchronize(kFnUsageHIToolboxDomain);

  // Nudge the input subsystem to re-read its preference. The exact channel
  // name varies across macOS versions; broadcast a few candidates and ignore
  // the (lack of) return value — these notifications have no acknowledge.
  notify_post("com.apple.HIToolbox.UpdateModifierMapping");
  notify_post("com.apple.HIToolbox.prefsChanged");
  notify_post("com.apple.keyboard.modifiermapping.changed");

  return Napi::Boolean::New(env, (okGlobal && okHIToolbox) ? true : false);
}

Napi::Object InitFnUsageType(Napi::Env env, Napi::Object exports) {
  exports.Set("getFnUsageType", Napi::Function::New(env, GetFnUsageType));
  exports.Set("setFnUsageType", Napi::Function::New(env, SetFnUsageType));
  return exports;
}
