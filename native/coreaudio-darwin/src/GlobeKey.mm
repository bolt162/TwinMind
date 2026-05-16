// GlobeKey.mm — Fn/Globe key listener via CGEventTap, in-process.
//
// Architecture: §5 (replaces the spawned `macos-globe-listener` Swift binary).
// By running the tap inside the TwinMind main process we get a single TCC
// Accessibility entry (the .app bundle) instead of two — granting permission
// to TwinMind is now enough to make Fn work, no second checkbox.
//
// Threading: CGEventTap requires a CFRunLoop. Electron's main-thread run loop
// is shared with V8 and AppKit; long JS turns would starve the tap and macOS
// would disable it (kCGEventTapDisabledByTimeout). We instead run the tap on
// a dedicated NSThread with its own CFRunLoop, and dispatch press/release
// events back to the JS thread via Napi::ThreadSafeFunction.
//
// Accessibility: CGEventTapCreate returns NULL if the process lacks the
// Accessibility privilege. Start() reports that as a boolean false to JS so
// the manager can re-try after the user grants permission (no app restart).
//
// Side-effects we keep from the Swift binary:
//   - Swallow Fn flagsChanged so macOS never sees it (no emoji panel)
//   - On Fn release, synthesize Esc to dismiss any panel that slipped through

#include <napi.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

namespace {

// Fn key hardware keycode (kVK_Function on macOS).
constexpr int64_t kVKFunction = 0x3F;
// Escape key for the dismiss-emoji-panel safety net.
constexpr int64_t kVKEscape = 0x35;
// kCGEventNull = 14 is NSSystemDefined, the emoji-panel hotkey route.
constexpr CGEventType kNSSystemDefined = (CGEventType)14;

struct GlobeCtx {
  Napi::ThreadSafeFunction onPress;
  Napi::ThreadSafeFunction onRelease;
  CFMachPortRef tap = NULL;
  CFRunLoopSourceRef source = NULL;
  CFRunLoopRef runLoop = NULL;
  NSThread *thread = nil;
  // Start() waits on this semaphore until the worker thread has either
  // successfully created the tap or determined that it cannot.
  dispatch_semaphore_t readySem = NULL;
  bool tapCreated = false;
  bool fnDown = false;
  bool stopping = false;
};

static CGEventRef EventTapCallback(CGEventTapProxy proxy, CGEventType type,
                                   CGEventRef event, void *refcon) {
  auto *ctx = (GlobeCtx *)refcon;
  if (!ctx) return event;

  // macOS disables taps that take too long or that the user interrupted.
  // Re-enable so we don't go dead until the next restart.
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (ctx->tap) CGEventTapEnable(ctx->tap, true);
    return event;
  }

  if (type == kCGEventFlagsChanged) {
    CGEventFlags flags = CGEventGetFlags(event);
    bool containsFn = (flags & kCGEventFlagMaskSecondaryFn) != 0;

    if (containsFn && !ctx->fnDown) {
      ctx->fnDown = true;
      if (ctx->onPress) {
        // Non-blocking: CGEventTap callbacks sit in the path of every
        // keyboard event in the system. BlockingCall here would freeze
        // the input stack any time JS is briefly busy — including hanging
        // macOS during permission revocation. Fire-and-forget is correct.
        ctx->onPress.NonBlockingCall(static_cast<void *>(nullptr),
            [](Napi::Env env, Napi::Function jsCallback, void *) {
              jsCallback.Call({});
            });
      }
    } else if (!containsFn && ctx->fnDown) {
      ctx->fnDown = false;
      if (ctx->onRelease) {
        ctx->onRelease.NonBlockingCall(static_cast<void *>(nullptr),
            [](Napi::Env env, Napi::Function jsCallback, void *) {
              jsCallback.Call({});
            });
      }
      // Dismiss any stray emoji panel that slipped through the SYSDEFINED
      // filter (fast Fn release sometimes wins the race).
      CGEventRef escDown = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)kVKEscape, true);
      CGEventRef escUp = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)kVKEscape, false);
      if (escDown) {
        CGEventPost(kCGHIDEventTap, escDown);
        CFRelease(escDown);
      }
      if (escUp) {
        CGEventPost(kCGHIDEventTap, escUp);
        CFRelease(escUp);
      }
    }

    // Drop the Fn flagsChanged so macOS never sees it (otherwise the emoji
    // panel pops up). Other flagsChanged events pass through.
    int64_t keycode = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    if (keycode == kVKFunction || containsFn) {
      return NULL;
    }
    return event;
  }

  // Block keyDown/keyUp for the Fn key itself.
  if (type == kCGEventKeyDown || type == kCGEventKeyUp) {
    int64_t keycode = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    if (keycode == kVKFunction) {
      return NULL;
    }
  }

  // While Fn is held, eat NSSystemDefined (the emoji-panel trigger). When
  // Fn is up these events pass through normally — also used for media keys.
  if (type == kNSSystemDefined && ctx->fnDown) {
    return NULL;
  }

  return event;
}

class GlobeKey : public Napi::ObjectWrap<GlobeKey> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "GlobeKey", {
      InstanceMethod("start", &GlobeKey::Start),
      InstanceMethod("stop", &GlobeKey::Stop),
      InstanceMethod("setOnPress", &GlobeKey::SetOnPress),
      InstanceMethod("setOnRelease", &GlobeKey::SetOnRelease),
    });
    auto ref = Napi::Persistent(func);
    ref.SuppressDestruct();
    exports.Set("GlobeKey", func);
    return exports;
  }

  GlobeKey(const Napi::CallbackInfo &info) : Napi::ObjectWrap<GlobeKey>(info) {
    ctx_ = new GlobeCtx();
  }

  ~GlobeKey() {
    if (!ctx_) return;
    StopInternal();
    delete ctx_;
    ctx_ = nullptr;
  }

 private:
  GlobeCtx *ctx_ = nullptr;

  Napi::Value SetOnPress(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!info[0].IsFunction()) return env.Undefined();
    if (ctx_->onPress) ctx_->onPress.Release();
    ctx_->onPress = Napi::ThreadSafeFunction::New(
        env, info[0].As<Napi::Function>(), "globekey_press", 0, 1);
    return env.Undefined();
  }

  Napi::Value SetOnRelease(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!info[0].IsFunction()) return env.Undefined();
    if (ctx_->onRelease) ctx_->onRelease.Release();
    ctx_->onRelease = Napi::ThreadSafeFunction::New(
        env, info[0].As<Napi::Function>(), "globekey_release", 0, 1);
    return env.Undefined();
  }

  // Returns true iff the CGEventTap was created (i.e., Accessibility is
  // granted). Idempotent: re-calling Start() while running is a no-op.
  Napi::Value Start(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (ctx_->thread != nil && !ctx_->thread.isFinished) {
      return Napi::Boolean::New(env, ctx_->tapCreated);
    }

    // Non-prompting trust check. Bail before touching CGEventTapCreate when
    // Accessibility isn't granted — calling tap-create on an untrusted
    // process makes macOS surface the TCC "would like to control this
    // computer" dialog, and the JS-side retry loop would re-trigger it
    // every poll. The onboarding "Grant" button is the only place we want
    // to explicitly prompt the user (via isTrustedAccessibilityClient(true)
    // in DarwinPermissionService).
    if (!AXIsProcessTrustedWithOptions(NULL)) {
      ctx_->tapCreated = false;
      return Napi::Boolean::New(env, false);
    }

    // Reset for a fresh attempt (e.g. user just granted Accessibility).
    ctx_->tapCreated = false;
    ctx_->fnDown = false;
    ctx_->stopping = false;
    ctx_->readySem = dispatch_semaphore_create(0);

    GlobeCtx *ctx = ctx_;
    ctx_->thread = [[NSThread alloc] initWithBlock:^{
      CGEventMask mask = CGEventMaskBit(kCGEventFlagsChanged) |
                         CGEventMaskBit(kCGEventKeyDown) |
                         CGEventMaskBit(kCGEventKeyUp) |
                         CGEventMaskBit(kNSSystemDefined);

      CFMachPortRef tap = CGEventTapCreate(
          kCGSessionEventTap,
          kCGHeadInsertEventTap,
          kCGEventTapOptionDefault,
          mask,
          &EventTapCallback,
          ctx);

      if (!tap) {
        // No Accessibility permission. Signal Start() and exit the thread.
        ctx->tapCreated = false;
        dispatch_semaphore_signal(ctx->readySem);
        return;
      }

      ctx->tap = tap;
      ctx->source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
      ctx->runLoop = CFRunLoopGetCurrent();
      CFRunLoopAddSource(ctx->runLoop, ctx->source, kCFRunLoopCommonModes);
      CGEventTapEnable(tap, true);
      ctx->tapCreated = true;

      dispatch_semaphore_signal(ctx->readySem);

      // Block here until Stop() calls CFRunLoopStop.
      CFRunLoopRun();

      // Tear down on the same thread that owns these objects.
      if (ctx->source) {
        CFRunLoopRemoveSource(ctx->runLoop, ctx->source, kCFRunLoopCommonModes);
        CFRelease(ctx->source);
        ctx->source = NULL;
      }
      if (ctx->tap) {
        CFRelease(ctx->tap);
        ctx->tap = NULL;
      }
      ctx->runLoop = NULL;
    }];
    [ctx_->thread setName:@"twinmind-globekey"];
    [ctx_->thread start];

    // Wait for the worker to either create the tap or report failure. The
    // worker signals the semaphore in both branches, so this can't hang.
    dispatch_semaphore_wait(ctx_->readySem, DISPATCH_TIME_FOREVER);
    ctx_->readySem = NULL;  // ARC releases the semaphore

    return Napi::Boolean::New(env, ctx_->tapCreated);
  }

  Napi::Value Stop(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    StopInternal();
    return env.Undefined();
  }

  void StopInternal() {
    if (!ctx_) return;
    ctx_->stopping = true;
    // Signal the worker thread's run loop to exit. The worker handles
    // cleanup on its own thread (where the run-loop source was added).
    if (ctx_->runLoop) {
      CFRunLoopStop(ctx_->runLoop);
    }
    // Release JS callback refs so V8 can GC the closures. New ones can be
    // attached via SetOnPress/SetOnRelease before the next Start().
    if (ctx_->onPress) {
      ctx_->onPress.Release();
      ctx_->onPress = Napi::ThreadSafeFunction();
    }
    if (ctx_->onRelease) {
      ctx_->onRelease.Release();
      ctx_->onRelease = Napi::ThreadSafeFunction();
    }
    // Don't block: the worker exits within a CFRunLoop tick. The destructor
    // is the only place we need to be strict, and JS owns the wrapper's
    // lifetime so it stays alive at least until Stop() returns to JS.
    ctx_->thread = nil;
  }
};

}  // namespace

Napi::Object InitGlobeKey(Napi::Env env, Napi::Object exports) {
  return GlobeKey::Init(env, exports);
}
