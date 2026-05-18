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
// We read/write the `com.apple.HIToolbox` preferences domain — NOT
// NSGlobalDomain, despite older documentation that suggests otherwise. On
// macOS 14+ (confirmed via System Settings → Keyboard diff), the toggle
// writes only to `~/Library/Preferences/com.apple.HIToolbox.plist`; writing
// to `kCFPreferencesAnyApplication` silently persists to a ghost key that
// nothing reads.

#include <napi.h>
#import <Foundation/Foundation.h>
#include <notify.h>

#define kFnUsageKey CFSTR("AppleFnUsageType")
#define kFnUsageDomain CFSTR("com.apple.HIToolbox")

// Returns the current AppleFnUsageType as a Number, or null if the key is
// unset (in which case the OS behaves as if it were 1).
static Napi::Value GetFnUsageType(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  CFPropertyListRef val = CFPreferencesCopyAppValue(kFnUsageKey, kFnUsageDomain);
  if (!val) return env.Null();

  int32_t out = -1;
  if (CFGetTypeID(val) == CFNumberGetTypeID()) {
    CFNumberGetValue((CFNumberRef)val, kCFNumberSInt32Type, &out);
  }
  CFRelease(val);
  if (out < 0) return env.Null();
  return Napi::Number::New(env, out);
}

// Persist `value` to NSGlobalDomain.AppleFnUsageType and nudge HIDServer to
// reload. Returns true if the persist+sync succeeded.
static Napi::Value SetFnUsageType(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    return Napi::Boolean::New(env, false);
  }
  int32_t value = info[0].As<Napi::Number>().Int32Value();

  CFNumberRef num = CFNumberCreate(NULL, kCFNumberSInt32Type, &value);
  if (!num) return Napi::Boolean::New(env, false);

  CFPreferencesSetAppValue(kFnUsageKey, num, kFnUsageDomain);
  CFRelease(num);

  Boolean ok = CFPreferencesAppSynchronize(kFnUsageDomain);

  // Nudge the input subsystem to re-read its preference. The exact channel
  // name varies across macOS versions; broadcast a few candidates and ignore
  // the (lack of) return value — these notifications have no acknowledge.
  notify_post("com.apple.HIToolbox.UpdateModifierMapping");
  notify_post("com.apple.HIToolbox.prefsChanged");
  notify_post("com.apple.keyboard.modifiermapping.changed");

  return Napi::Boolean::New(env, ok ? true : false);
}

Napi::Object InitFnUsageType(Napi::Env env, Napi::Object exports) {
  exports.Set("getFnUsageType", Napi::Function::New(env, GetFnUsageType));
  exports.Set("setFnUsageType", Napi::Function::New(env, SetFnUsageType));
  return exports;
}
