// DeviceChangeMonitor.mm — default-input device change observer.
//
// Architecture: §7.7 (device-change recovery). The audio-process emits
// device-change events while capturing; this class watches the system-level
// `kAudioHardwarePropertyDefaultInputDevice` so we also see route flips
// while idle (e.g., user plugs in AirPods between sessions).
//
// We emit a single `change` event with { label, kind, noDevice } on each
// flip. Listener fires on the JS thread via ThreadSafeFunction.

#include <napi.h>
#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>

namespace {

struct DevCtx {
  Napi::ThreadSafeFunction onChange;
  bool subscribed = false;
  AudioDeviceID lastDeviceId = kAudioObjectUnknown;
};

static AudioDeviceID GetDefaultInputDevice() {
  AudioObjectPropertyAddress addr = {
      kAudioHardwarePropertyDefaultInputDevice,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain
  };
  AudioDeviceID dev = kAudioObjectUnknown;
  UInt32 size = sizeof(dev);
  AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, NULL, &size, &dev);
  return dev;
}

/** Best-effort: copy the device's human-readable name. Returns nil if unknown. */
static NSString *CopyDeviceName(AudioDeviceID dev) {
  if (dev == kAudioObjectUnknown) return nil;
  AudioObjectPropertyAddress addr = {
      kAudioObjectPropertyName,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain
  };
  CFStringRef name = NULL;
  UInt32 size = sizeof(name);
  if (AudioObjectGetPropertyData(dev, &addr, 0, NULL, &size, &name) != noErr || !name) return nil;
  NSString *s = (__bridge_transfer NSString *)name;
  return s;
}

/**
 * Best-effort kind classification: read the transport type and map to one of
 * 'built_in' | 'bluetooth' | 'usb' | 'other'. The renderer treats this as a
 * coarse hint; the label is the authoritative display string.
 */
static const char *ClassifyDeviceKind(AudioDeviceID dev) {
  if (dev == kAudioObjectUnknown) return "other";
  AudioObjectPropertyAddress addr = {
      kAudioDevicePropertyTransportType,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain
  };
  UInt32 transport = 0;
  UInt32 size = sizeof(transport);
  if (AudioObjectGetPropertyData(dev, &addr, 0, NULL, &size, &transport) != noErr) return "other";
  switch (transport) {
    case kAudioDeviceTransportTypeBuiltIn: return "built_in";
    case kAudioDeviceTransportTypeBluetooth:
    case kAudioDeviceTransportTypeBluetoothLE: return "bluetooth";
    case kAudioDeviceTransportTypeUSB: return "usb";
    default: return "other";
  }
}

class DeviceChangeMonitor : public Napi::ObjectWrap<DeviceChangeMonitor> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "DeviceChangeMonitor", {
      InstanceMethod("start", &DeviceChangeMonitor::Start),
      InstanceMethod("stop", &DeviceChangeMonitor::Stop),
      InstanceMethod("setOnChange", &DeviceChangeMonitor::SetOnChange),
    });
    auto ref = Napi::Persistent(func);
    ref.SuppressDestruct();
    exports.Set("DeviceChangeMonitor", func);
    return exports;
  }

  DeviceChangeMonitor(const Napi::CallbackInfo &info)
      : Napi::ObjectWrap<DeviceChangeMonitor>(info) {
    ctx_ = new DevCtx();
  }

  ~DeviceChangeMonitor() {
    if (ctx_) {
      StopInternal();
      delete ctx_;
      ctx_ = nullptr;
    }
  }

 private:
  DevCtx *ctx_ = nullptr;

  Napi::Value SetOnChange(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!info[0].IsFunction()) return env.Undefined();
    if (ctx_->onChange) ctx_->onChange.Release();
    ctx_->onChange = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(),
                                                   "device_change_monitor", 0, 1);
    return env.Undefined();
  }

  static OSStatus PropertyListener(
      AudioObjectID inObjectID,
      UInt32 inNumberAddresses,
      const AudioObjectPropertyAddress *inAddresses,
      void *inClientData) {
    auto *self = (DeviceChangeMonitor *)inClientData;
    if (!self || !self->ctx_) return noErr;
    for (UInt32 i = 0; i < inNumberAddresses; i++) {
      if (inAddresses[i].mSelector == kAudioHardwarePropertyDefaultInputDevice) {
        self->EmitIfChanged();
      }
    }
    return noErr;
  }

  void EmitIfChanged() {
    AudioDeviceID dev = GetDefaultInputDevice();
    if (dev == ctx_->lastDeviceId) return;
    ctx_->lastDeviceId = dev;
    if (!ctx_->onChange) return;

    NSString *name = CopyDeviceName(dev);
    const char *kind = ClassifyDeviceKind(dev);
    bool noDevice = (dev == kAudioObjectUnknown);
    std::string labelStr = name ? std::string([name UTF8String]) : std::string();

    ctx_->onChange.BlockingCall([labelStr, kind, noDevice](Napi::Env env, Napi::Function js) {
      Napi::Object o = Napi::Object::New(env);
      if (!labelStr.empty()) {
        o.Set("label", Napi::String::New(env, labelStr));
      } else {
        o.Set("label", env.Null());
      }
      o.Set("kind", Napi::String::New(env, kind));
      o.Set("noDevice", Napi::Boolean::New(env, noDevice));
      js.Call({o});
    });
  }

  Napi::Value Start(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!ctx_->subscribed) {
      AudioObjectPropertyAddress addr = {
          kAudioHardwarePropertyDefaultInputDevice,
          kAudioObjectPropertyScopeGlobal,
          kAudioObjectPropertyElementMain
      };
      AudioObjectAddPropertyListener(kAudioObjectSystemObject, &addr,
                                     &PropertyListener, this);
      ctx_->subscribed = true;
    }
    // Prime lastDeviceId without emitting (first non-change is just the
    // current state, not a transition).
    ctx_->lastDeviceId = GetDefaultInputDevice();
    return env.Undefined();
  }

  Napi::Value Stop(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    StopInternal();
    return env.Undefined();
  }

  void StopInternal() {
    if (!ctx_) return;
    if (ctx_->subscribed) {
      AudioObjectPropertyAddress addr = {
          kAudioHardwarePropertyDefaultInputDevice,
          kAudioObjectPropertyScopeGlobal,
          kAudioObjectPropertyElementMain
      };
      AudioObjectRemovePropertyListener(kAudioObjectSystemObject, &addr,
                                        &PropertyListener, this);
      ctx_->subscribed = false;
    }
    ctx_->lastDeviceId = kAudioObjectUnknown;
  }
};

}  // namespace

Napi::Object InitDeviceChangeMonitor(Napi::Env env, Napi::Object exports) {
  return DeviceChangeMonitor::Init(env, exports);
}
