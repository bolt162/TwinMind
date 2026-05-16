// MicMonitor.mm — kAudioDevicePropertyDeviceIsRunningSomewhere monitor.
//
// Architecture: §8.1 (meeting auto-detection primitive). No TCC prompt
// required — this is a device-state read, not a content read.
//
// We subscribe to changes on the *current default input device*, and
// re-subscribe when the default flips. The property is `true` whenever any
// process in the system has an active input stream on that device. We emit
// `started` / `stopped` events on the JS thread via ThreadSafeFunction.

#include <napi.h>
#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>

namespace {

struct MonCtx {
  Napi::ThreadSafeFunction onStarted;
  Napi::ThreadSafeFunction onStopped;
  AudioDeviceID currentDevice = kAudioObjectUnknown;
  bool subscribedToDefault = false;
  bool subscribedToDevice = false;
  bool lastRunningSomewhere = false;
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

static bool ReadRunningSomewhere(AudioDeviceID dev) {
  if (dev == kAudioObjectUnknown) return false;
  AudioObjectPropertyAddress addr = {
      kAudioDevicePropertyDeviceIsRunningSomewhere,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain
  };
  UInt32 running = 0;
  UInt32 size = sizeof(running);
  if (AudioObjectGetPropertyData(dev, &addr, 0, NULL, &size, &running) != noErr) return false;
  return running != 0;
}

class MicMonitor : public Napi::ObjectWrap<MicMonitor> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "MicMonitor", {
      InstanceMethod("start", &MicMonitor::Start),
      InstanceMethod("stop", &MicMonitor::Stop),
      InstanceMethod("setOnStarted", &MicMonitor::SetOnStarted),
      InstanceMethod("setOnStopped", &MicMonitor::SetOnStopped),
    });
    auto ref = Napi::Persistent(func);
    ref.SuppressDestruct();
    exports.Set("MicMonitor", func);
    return exports;
  }

  MicMonitor(const Napi::CallbackInfo &info) : Napi::ObjectWrap<MicMonitor>(info) {
    ctx_ = new MonCtx();
  }

  ~MicMonitor() {
    if (ctx_) {
      StopInternal();
      delete ctx_;
      ctx_ = nullptr;
    }
  }

 private:
  MonCtx *ctx_ = nullptr;

  Napi::Value SetOnStarted(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!info[0].IsFunction()) return env.Undefined();
    if (ctx_->onStarted) ctx_->onStarted.Release();
    ctx_->onStarted = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(),
                                                    "mic_monitor_started", 0, 1);
    return env.Undefined();
  }

  Napi::Value SetOnStopped(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!info[0].IsFunction()) return env.Undefined();
    if (ctx_->onStopped) ctx_->onStopped.Release();
    ctx_->onStopped = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(),
                                                    "mic_monitor_stopped", 0, 1);
    return env.Undefined();
  }

  // Property listener trampoline; CoreAudio invokes this on its own queue.
  static OSStatus PropertyListener(
      AudioObjectID inObjectID,
      UInt32 inNumberAddresses,
      const AudioObjectPropertyAddress *inAddresses,
      void *inClientData) {
    auto *self = (MicMonitor *)inClientData;
    if (!self || !self->ctx_) return noErr;

    for (UInt32 i = 0; i < inNumberAddresses; i++) {
      const auto &addr = inAddresses[i];
      if (addr.mSelector == kAudioHardwarePropertyDefaultInputDevice) {
        self->RebindToDefault();
      } else if (addr.mSelector == kAudioDevicePropertyDeviceIsRunningSomewhere) {
        self->EmitIfChanged();
      }
    }
    return noErr;
  }

  void RebindToDefault() {
    if (ctx_->subscribedToDevice && ctx_->currentDevice != kAudioObjectUnknown) {
      AudioObjectPropertyAddress addr = {
          kAudioDevicePropertyDeviceIsRunningSomewhere,
          kAudioObjectPropertyScopeGlobal,
          kAudioObjectPropertyElementMain
      };
      AudioObjectRemovePropertyListener(ctx_->currentDevice, &addr, &PropertyListener, this);
      ctx_->subscribedToDevice = false;
    }
    AudioDeviceID dev = GetDefaultInputDevice();
    ctx_->currentDevice = dev;
    if (dev != kAudioObjectUnknown) {
      AudioObjectPropertyAddress addr = {
          kAudioDevicePropertyDeviceIsRunningSomewhere,
          kAudioObjectPropertyScopeGlobal,
          kAudioObjectPropertyElementMain
      };
      AudioObjectAddPropertyListener(dev, &addr, &PropertyListener, this);
      ctx_->subscribedToDevice = true;
    }
    EmitIfChanged();
  }

  void EmitIfChanged() {
    bool running = ReadRunningSomewhere(ctx_->currentDevice);
    if (running == ctx_->lastRunningSomewhere) return;
    ctx_->lastRunningSomewhere = running;
    if (running && ctx_->onStarted) {
      ctx_->onStarted.BlockingCall([](Napi::Env env, Napi::Function js) {
        js.Call({Napi::Object::New(env)});
      });
    } else if (!running && ctx_->onStopped) {
      ctx_->onStopped.BlockingCall([](Napi::Env env, Napi::Function js) {
        js.Call({Napi::Object::New(env)});
      });
    }
  }

  Napi::Value Start(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!ctx_->subscribedToDefault) {
      AudioObjectPropertyAddress addr = {
          kAudioHardwarePropertyDefaultInputDevice,
          kAudioObjectPropertyScopeGlobal,
          kAudioObjectPropertyElementMain
      };
      AudioObjectAddPropertyListener(kAudioObjectSystemObject, &addr,
                                     &PropertyListener, this);
      ctx_->subscribedToDefault = true;
    }
    RebindToDefault();
    return env.Undefined();
  }

  Napi::Value Stop(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    StopInternal();
    return env.Undefined();
  }

  void StopInternal() {
    if (!ctx_) return;
    if (ctx_->subscribedToDefault) {
      AudioObjectPropertyAddress addr = {
          kAudioHardwarePropertyDefaultInputDevice,
          kAudioObjectPropertyScopeGlobal,
          kAudioObjectPropertyElementMain
      };
      AudioObjectRemovePropertyListener(kAudioObjectSystemObject, &addr,
                                        &PropertyListener, this);
      ctx_->subscribedToDefault = false;
    }
    if (ctx_->subscribedToDevice && ctx_->currentDevice != kAudioObjectUnknown) {
      AudioObjectPropertyAddress addr = {
          kAudioDevicePropertyDeviceIsRunningSomewhere,
          kAudioObjectPropertyScopeGlobal,
          kAudioObjectPropertyElementMain
      };
      AudioObjectRemovePropertyListener(ctx_->currentDevice, &addr,
                                        &PropertyListener, this);
      ctx_->subscribedToDevice = false;
    }
    ctx_->currentDevice = kAudioObjectUnknown;
  }
};

}  // namespace

Napi::Object InitMicMonitor(Napi::Env env, Napi::Object exports) {
  return MicMonitor::Init(env, exports);
}
