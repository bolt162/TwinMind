// Paste.mm — Synthesize a Cmd+V keystroke via CGEventPost.
//
// Architecture: §7.4 (dictation completes with a paste).
//
// Replaces the previous osascript path. `osascript` driving "System Events"
// counts as Apple Events / Automation, which is a *separate* TCC bucket from
// Accessibility — so even after the user grants Accessibility in onboarding,
// the first paste used to surface a second "TwinMind wants to control
// System Events" dialog. CGEventPost only needs Accessibility (already
// granted), so the second prompt goes away entirely.

#include <napi.h>
#import <ApplicationServices/ApplicationServices.h>

namespace {
// Virtual keycode for the 'V' key on US ANSI layouts. The Cmd-V shortcut is
// the same on every keyboard layout because macOS dispatches keyboard
// shortcuts by keycode, not by character.
constexpr int64_t kVKAnsiV = 0x09;
}

// Posts <Cmd-down>V<Cmd-up> at the HID event tap. Returns true if the events
// were created and posted. macOS will silently drop the post if the process
// isn't Accessibility-trusted, in which case the caller should fall back to
// clipboard-only.
static Napi::Value PasteCommandV(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  CGEventSourceRef source =
      CGEventSourceCreate(kCGEventSourceStateCombinedSessionState);
  if (!source) return Napi::Boolean::New(env, false);

  CGEventRef vDown = CGEventCreateKeyboardEvent(source, (CGKeyCode)kVKAnsiV, true);
  CGEventRef vUp = CGEventCreateKeyboardEvent(source, (CGKeyCode)kVKAnsiV, false);
  if (!vDown || !vUp) {
    if (vDown) CFRelease(vDown);
    if (vUp) CFRelease(vUp);
    CFRelease(source);
    return Napi::Boolean::New(env, false);
  }

  CGEventSetFlags(vDown, kCGEventFlagMaskCommand);
  CGEventSetFlags(vUp, kCGEventFlagMaskCommand);

  CGEventPost(kCGHIDEventTap, vDown);
  CGEventPost(kCGHIDEventTap, vUp);

  CFRelease(vDown);
  CFRelease(vUp);
  CFRelease(source);

  return Napi::Boolean::New(env, true);
}

Napi::Object InitPaste(Napi::Env env, Napi::Object exports) {
  exports.Set("pasteCommandV", Napi::Function::New(env, PasteCommandV));
  return exports;
}
