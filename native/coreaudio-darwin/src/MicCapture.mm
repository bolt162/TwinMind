// MicCapture.mm — AUHAL-based mic capture.
//
// Architecture: §7.1 (IMicCapture contract), §7.7 (device change behavior).
//
// Why AUHAL instead of AVAudioEngine:
//   AVAudioEngine lazily initializes its input audio unit when `inputNode` is
//   accessed; subsequently setting `kAudioOutputUnitProperty_CurrentDevice` on
//   that unit returns noErr but doesn't actually rebind the I/O graph. This
//   was the "frozen at 0:00 when explicit device pin is set" bug. AUHAL
//   (kAudioUnitSubType_HALOutput) is Apple's documented API for "capture from
//   a specific device that may or may not be the system default" — we own
//   the entire init/start/stop lifecycle.
//
// Two modes:
//   - followingSystemDefault == true  (deviceId arg empty)
//       Bind to whatever the current system default is. Install a property
//       listener on kAudioHardwarePropertyDefaultInputDevice; on change,
//       stop+reinit the audio unit with the new default and emit 'rebound'.
//   - followingSystemDefault == false (deviceId arg non-empty)
//       Pin to that specific UID. No listener. If the device disappears, the
//       AudioUnit's render proc errors out and we emit 'error' with
//       message='device_disappeared' so the orchestrator can pause the
//       session (see RecordingOrchestrator pauseForDeviceLoss).
//
// Threading: AudioUnit's render proc runs on a CoreAudio real-time thread.
// We never call JS or allocate from there directly — TSFN.BlockingCall posts
// to the JS thread which allocates a Node Buffer there. The property
// listener also runs on a CoreAudio thread; we marshal its rebind work onto
// a dispatch queue so we don't manipulate the AudioUnit from the listener
// thread.

#include <napi.h>
#include <string>
#include <vector>
#include <atomic>
#include <mutex>
#import <Foundation/Foundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreAudio/CoreAudio.h>

namespace {

constexpr Float64 kTargetSampleRate = 16000.0;
constexpr UInt32 kTargetChannels = 1;

// ─── Device enumeration helpers ────────────────────────────────────────────

/** Look up an AudioObjectID by its UID string. Returns kAudioObjectUnknown
 *  if not found (device unplugged, typo, etc.). */
static AudioObjectID ResolveDeviceByUID(const std::string &uid) {
  CFStringRef cfUid = CFStringCreateWithCString(
      kCFAllocatorDefault, uid.c_str(), kCFStringEncodingUTF8);
  if (!cfUid) return kAudioObjectUnknown;
  AudioObjectID deviceID = kAudioObjectUnknown;
  UInt32 size = sizeof(deviceID);
  AudioObjectPropertyAddress addr = {
      kAudioHardwarePropertyTranslateUIDToDevice,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain
  };
  OSStatus status = AudioObjectGetPropertyData(
      kAudioObjectSystemObject, &addr, sizeof(cfUid), &cfUid, &size, &deviceID);
  CFRelease(cfUid);
  if (status != noErr) return kAudioObjectUnknown;
  return deviceID;
}

/** Read a CFString property and return as std::string ("" on failure). */
static std::string ReadStringProperty(AudioObjectID device,
                                       AudioObjectPropertySelector selector) {
  AudioObjectPropertyAddress addr = {
      selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
  };
  CFStringRef value = nullptr;
  UInt32 size = sizeof(value);
  OSStatus status = AudioObjectGetPropertyData(
      device, &addr, 0, nullptr, &size, &value);
  if (status != noErr || !value) return "";
  char buf[256] = {0};
  CFStringGetCString(value, buf, sizeof(buf), kCFStringEncodingUTF8);
  CFRelease(value);
  return std::string(buf);
}

/** True iff the device has at least one input stream. */
static bool DeviceHasInputStreams(AudioObjectID device) {
  AudioObjectPropertyAddress addr = {
      kAudioDevicePropertyStreams,
      kAudioDevicePropertyScopeInput,
      kAudioObjectPropertyElementMain
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(device, &addr, 0, nullptr, &size) != noErr) {
    return false;
  }
  return size > 0;
}

static AudioObjectID GetDefaultInputDeviceID() {
  AudioObjectPropertyAddress addr = {
      kAudioHardwarePropertyDefaultInputDevice,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain
  };
  AudioObjectID dev = kAudioObjectUnknown;
  UInt32 size = sizeof(dev);
  AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, nullptr, &size, &dev);
  return dev;
}

/** Read kAudioDevicePropertyTransportType and bucket into the four kinds the
 *  picker UI groups by. Empty/unknown maps to "other". */
static std::string GetDeviceTransportKind(AudioObjectID device) {
  AudioObjectPropertyAddress addr = {
      kAudioDevicePropertyTransportType,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain
  };
  UInt32 transport = 0;
  UInt32 size = sizeof(transport);
  OSStatus s = AudioObjectGetPropertyData(device, &addr, 0, nullptr, &size, &transport);
  if (s != noErr) return "other";
  switch (transport) {
    case kAudioDeviceTransportTypeBuiltIn:
      return "built_in";
    case kAudioDeviceTransportTypeBluetooth:
    case kAudioDeviceTransportTypeBluetoothLE:
      return "bluetooth";
    case kAudioDeviceTransportTypeUSB:
      return "usb";
    default:
      return "other";
  }
}

/**
 * Enumerate all CoreAudio devices that expose input streams and return them
 * as a JS array of { id (UID string), name, isDefault, kind }.
 */
static Napi::Value ListInputDevices(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  AudioObjectPropertyAddress devicesAddr = {
      kAudioHardwarePropertyDevices,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain
  };
  UInt32 dataSize = 0;
  OSStatus status = AudioObjectGetPropertyDataSize(
      kAudioObjectSystemObject, &devicesAddr, 0, nullptr, &dataSize);
  if (status != noErr) return Napi::Array::New(env, 0);

  size_t deviceCount = dataSize / sizeof(AudioObjectID);
  std::vector<AudioObjectID> devices(deviceCount);
  status = AudioObjectGetPropertyData(
      kAudioObjectSystemObject, &devicesAddr, 0, nullptr, &dataSize, devices.data());
  if (status != noErr) return Napi::Array::New(env, 0);

  AudioObjectID defaultID = GetDefaultInputDeviceID();

  Napi::Array result = Napi::Array::New(env, 0);
  uint32_t outIdx = 0;
  for (AudioObjectID device : devices) {
    if (!DeviceHasInputStreams(device)) continue;
    std::string uid = ReadStringProperty(device, kAudioDevicePropertyDeviceUID);
    std::string name = ReadStringProperty(device, kAudioObjectPropertyName);
    if (uid.empty()) continue;
    Napi::Object entry = Napi::Object::New(env);
    entry.Set("id", Napi::String::New(env, uid));
    entry.Set("name", Napi::String::New(env, name.empty() ? uid : name));
    entry.Set("isDefault", Napi::Boolean::New(env, device == defaultID));
    entry.Set("kind", Napi::String::New(env, GetDeviceTransportKind(device)));
    result.Set(outIdx++, entry);
  }
  return result;
}

// ─── MicCapture ────────────────────────────────────────────────────────────

// JS-side context held by the MicCapture instance + captured by the
// AudioUnit input proc. All fields touched from the audio thread must be
// set up BEFORE AudioOutputUnitStart and torn down AFTER AudioOutputUnitStop.
struct Ctx {
  Napi::ThreadSafeFunction onPcm;
  Napi::ThreadSafeFunction onError;
  Napi::ThreadSafeFunction onDeviceChange;
  Napi::ThreadSafeFunction onRebound;

  // Audio unit + conversion state.
  AudioUnit auHal = nullptr;
  AudioConverterRef converter = nullptr;
  AudioStreamBasicDescription inputFormat = {};
  AudioStreamBasicDescription targetFormat = {};

  // Pre-allocated buffer for AudioUnitRender (one frame in the input format).
  // Reused across render-proc invocations; only the audio thread touches it.
  AudioBufferList *renderBufferList = nullptr;
  UInt32 renderBufferCapacity = 0; // frames

  AudioObjectID currentDeviceID = kAudioObjectUnknown;
  bool followingSystemDefault = false;
  bool defaultListenerInstalled = false;
  std::atomic<bool> started{false};

  // Serial queue for property-listener-driven rebinds. CoreAudio property
  // listeners fire on internal threads we don't own; we hop to this queue so
  // we never reconfigure the AudioUnit while it's mid-render.
  dispatch_queue_t rebindQueue = nullptr;
};

// Forward declarations.
static OSStatus InputProc(void *inRefCon,
                          AudioUnitRenderActionFlags *ioActionFlags,
                          const AudioTimeStamp *inTimeStamp,
                          UInt32 inBusNumber,
                          UInt32 inNumberFrames,
                          AudioBufferList *ioData);
static OSStatus DefaultDeviceChanged(AudioObjectID inObjectID,
                                     UInt32 inNumberAddresses,
                                     const AudioObjectPropertyAddress *inAddresses,
                                     void *inClientData);

class MicCapture : public Napi::ObjectWrap<MicCapture> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "MicCapture", {
      InstanceMethod("start", &MicCapture::Start),
      InstanceMethod("stop", &MicCapture::Stop),
      InstanceMethod("setDevice", &MicCapture::SetDevice),
      InstanceMethod("setOnPcm", &MicCapture::SetOnPcm),
      InstanceMethod("setOnError", &MicCapture::SetOnError),
      InstanceMethod("setOnDeviceChange", &MicCapture::SetOnDeviceChange),
      InstanceMethod("setOnRebound", &MicCapture::SetOnRebound),
    });
    auto ref = Napi::Persistent(func);
    ref.SuppressDestruct();
    exports.Set("MicCapture", func);
    return exports;
  }

  MicCapture(const Napi::CallbackInfo &info) : Napi::ObjectWrap<MicCapture>(info) {
    ctx_ = new Ctx();
    ctx_->rebindQueue = dispatch_queue_create(
        "com.twinmind.coreaudio.rebind", DISPATCH_QUEUE_SERIAL);
  }

  ~MicCapture() {
    if (ctx_) {
      StopInternal();
      if (ctx_->rebindQueue) {
        // dispatch_queue is ARC-managed under MRC objc++; release implicitly
        // when ctx is deleted. Nothing else to do.
      }
      delete ctx_;
      ctx_ = nullptr;
    }
  }

 private:
  Ctx *ctx_ = nullptr;

  Napi::Value SetOnPcm(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!info[0].IsFunction()) return env.Undefined();
    if (ctx_->onPcm) ctx_->onPcm.Release();
    ctx_->onPcm = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(),
                                                "coreaudio_pcm", 0, 1);
    return env.Undefined();
  }

  Napi::Value SetOnError(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!info[0].IsFunction()) return env.Undefined();
    if (ctx_->onError) ctx_->onError.Release();
    ctx_->onError = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(),
                                                  "coreaudio_error", 0, 1);
    return env.Undefined();
  }

  Napi::Value SetOnDeviceChange(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!info[0].IsFunction()) return env.Undefined();
    if (ctx_->onDeviceChange) ctx_->onDeviceChange.Release();
    ctx_->onDeviceChange = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(),
                                                         "coreaudio_devchg", 0, 1);
    return env.Undefined();
  }

  Napi::Value SetOnRebound(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!info[0].IsFunction()) return env.Undefined();
    if (ctx_->onRebound) ctx_->onRebound.Release();
    ctx_->onRebound = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(),
                                                    "coreaudio_rebound", 0, 1);
    return env.Undefined();
  }

  /**
   * start(deviceId?: string)
   *
   * deviceId = "" or undefined → auto-detect (system default), live-switches
   *   on kAudioHardwarePropertyDefaultInputDevice change.
   * deviceId = a UID string     → pin to that device; no switching.
   */
  Napi::Value Start(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (ctx_->started.load()) return env.Undefined();

    std::string uidStr;
    if (info.Length() >= 1 && info[0].IsString()) {
      uidStr = info[0].As<Napi::String>().Utf8Value();
    }
    ctx_->followingSystemDefault = uidStr.empty();

    AudioObjectID deviceID = uidStr.empty()
        ? GetDefaultInputDeviceID()
        : ResolveDeviceByUID(uidStr);
    if (deviceID == kAudioObjectUnknown) {
      // Pinned UID didn't resolve. Don't silently fall back — pinned means
      // pinned, and the orchestrator needs to know we couldn't open it.
      Napi::Error::New(env, "device_disappeared").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    std::string err;
    if (!OpenAndStartUnit(deviceID, err)) {
      Napi::Error::New(env, err.c_str()).ThrowAsJavaScriptException();
      return env.Undefined();
    }

    // Auto-detect: install the listener so we can swap to whatever the system
    // default flips to mid-recording.
    if (ctx_->followingSystemDefault && !ctx_->defaultListenerInstalled) {
      AudioObjectPropertyAddress addr = {
          kAudioHardwarePropertyDefaultInputDevice,
          kAudioObjectPropertyScopeGlobal,
          kAudioObjectPropertyElementMain
      };
      OSStatus s = AudioObjectAddPropertyListener(
          kAudioObjectSystemObject, &addr, DefaultDeviceChanged, ctx_);
      if (s == noErr) ctx_->defaultListenerInstalled = true;
    }
    return env.Undefined();
  }

  /**
   * setDevice(deviceId: string)
   *
   * Mid-session hot-swap. Called by main when the user picks a different
   * device in Settings while recording. Equivalent to stop+start with the
   * new deviceId, but without tearing down the JS-side callbacks. Emits
   * 'rebound' on success.
   */
  Napi::Value SetDevice(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    std::string uidStr;
    if (info.Length() >= 1 && info[0].IsString()) {
      uidStr = info[0].As<Napi::String>().Utf8Value();
    }
    const bool nowFollowingDefault = uidStr.empty();

    dispatch_async(ctx_->rebindQueue, ^{
      AudioObjectID newDeviceID = nowFollowingDefault
          ? GetDefaultInputDeviceID()
          : ResolveDeviceByUID(uidStr);
      if (newDeviceID == kAudioObjectUnknown) {
        EmitError("device_disappeared");
        return;
      }
      // Toggle the default listener to match the new mode.
      AudioObjectPropertyAddress addr = {
          kAudioHardwarePropertyDefaultInputDevice,
          kAudioObjectPropertyScopeGlobal,
          kAudioObjectPropertyElementMain
      };
      if (nowFollowingDefault && !ctx_->defaultListenerInstalled) {
        if (AudioObjectAddPropertyListener(kAudioObjectSystemObject, &addr,
                                            DefaultDeviceChanged, ctx_) == noErr) {
          ctx_->defaultListenerInstalled = true;
        }
      } else if (!nowFollowingDefault && ctx_->defaultListenerInstalled) {
        AudioObjectRemovePropertyListener(kAudioObjectSystemObject, &addr,
                                           DefaultDeviceChanged, ctx_);
        ctx_->defaultListenerInstalled = false;
      }
      ctx_->followingSystemDefault = nowFollowingDefault;

      std::string err;
      RebindToDevice(newDeviceID, err);
    });
    return env.Undefined();
  }

  Napi::Value Stop(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    StopInternal();
    return env.Undefined();
  }

  // ─── Internal helpers ─────────────────────────────────────────────────

  /** Open an AUHAL unit bound to `deviceID`, configure the converter, register
   *  the input proc, initialize + start. Returns true on success; populates
   *  err on failure. ctx_->auHal is set on success. */
  bool OpenAndStartUnit(AudioObjectID deviceID, std::string &err) {
    AudioComponentDescription desc = {
        kAudioUnitType_Output,
        kAudioUnitSubType_HALOutput,
        kAudioUnitManufacturer_Apple,
        0, 0
    };
    AudioComponent comp = AudioComponentFindNext(nullptr, &desc);
    if (!comp) { err = "no AUHAL component"; return false; }

    AudioUnit unit = nullptr;
    OSStatus s = AudioComponentInstanceNew(comp, &unit);
    if (s != noErr || !unit) {
      err = "AudioComponentInstanceNew failed";
      return false;
    }

    // Enable input (bus 1), disable output (bus 0). Documented HAL pattern.
    UInt32 enable = 1, disable = 0;
    s = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO,
                              kAudioUnitScope_Input, 1, &enable, sizeof(enable));
    if (s != noErr) { err = "EnableIO(input) failed"; AudioComponentInstanceDispose(unit); return false; }
    s = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO,
                              kAudioUnitScope_Output, 0, &disable, sizeof(disable));
    if (s != noErr) { err = "EnableIO(output) failed"; AudioComponentInstanceDispose(unit); return false; }

    // Bind to the chosen device BEFORE AudioUnitInitialize — this is exactly
    // the ordering that AVAudioEngine couldn't give us.
    s = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                              kAudioUnitScope_Global, 0, &deviceID, sizeof(deviceID));
    if (s != noErr) { err = "CurrentDevice failed"; AudioComponentInstanceDispose(unit); return false; }

    // Discover the device's native input format on bus 1 (input scope).
    AudioStreamBasicDescription deviceFormat = {};
    UInt32 propSize = sizeof(deviceFormat);
    s = AudioUnitGetProperty(unit, kAudioUnitProperty_StreamFormat,
                              kAudioUnitScope_Input, 1, &deviceFormat, &propSize);
    if (s != noErr) { err = "get device format failed"; AudioComponentInstanceDispose(unit); return false; }

    // Force the unit's OUTPUT scope on bus 1 (what we'll pull via
    // AudioUnitRender) to packed Float32 mono at the device's rate. The
    // AudioConverter then does sample-rate + format conversion to 16 kHz
    // int16. This split makes AudioUnitRender stable across devices (which
    // may have anywhere from 1 to 8 channels at 16-96 kHz).
    AudioStreamBasicDescription unitOutputFormat = {};
    unitOutputFormat.mSampleRate = deviceFormat.mSampleRate;
    unitOutputFormat.mFormatID = kAudioFormatLinearPCM;
    unitOutputFormat.mFormatFlags = kAudioFormatFlagIsFloat
                                    | kAudioFormatFlagIsPacked;
    unitOutputFormat.mBytesPerPacket = sizeof(Float32);
    unitOutputFormat.mFramesPerPacket = 1;
    unitOutputFormat.mBytesPerFrame = sizeof(Float32);
    unitOutputFormat.mChannelsPerFrame = 1;
    unitOutputFormat.mBitsPerChannel = 32;
    s = AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat,
                              kAudioUnitScope_Output, 1,
                              &unitOutputFormat, sizeof(unitOutputFormat));
    if (s != noErr) {
      // Channel-count downmix isn't always honored; retry preserving the
      // device's channel count.
      unitOutputFormat.mChannelsPerFrame = deviceFormat.mChannelsPerFrame;
      unitOutputFormat.mBytesPerPacket = sizeof(Float32) * unitOutputFormat.mChannelsPerFrame;
      unitOutputFormat.mBytesPerFrame  = sizeof(Float32) * unitOutputFormat.mChannelsPerFrame;
      s = AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat,
                                kAudioUnitScope_Output, 1,
                                &unitOutputFormat, sizeof(unitOutputFormat));
      if (s != noErr) { err = "set unit output format failed"; AudioComponentInstanceDispose(unit); return false; }
    }
    ctx_->inputFormat = unitOutputFormat;

    // Target format the JS side ultimately consumes.
    AudioStreamBasicDescription target = {};
    target.mSampleRate = kTargetSampleRate;
    target.mFormatID = kAudioFormatLinearPCM;
    target.mFormatFlags = kAudioFormatFlagIsSignedInteger
                        | kAudioFormatFlagIsPacked;
    target.mBytesPerPacket = sizeof(int16_t) * kTargetChannels;
    target.mFramesPerPacket = 1;
    target.mBytesPerFrame  = sizeof(int16_t) * kTargetChannels;
    target.mChannelsPerFrame = kTargetChannels;
    target.mBitsPerChannel = 16;
    ctx_->targetFormat = target;

    // Build the format converter (Float32 N-ch @ deviceRate → int16 mono @ 16 kHz).
    AudioConverterRef converter = nullptr;
    s = AudioConverterNew(&unitOutputFormat, &target, &converter);
    if (s != noErr || !converter) {
      err = "AudioConverterNew failed";
      AudioComponentInstanceDispose(unit);
      return false;
    }

    // Install the input callback.
    AURenderCallbackStruct cb = { InputProc, ctx_ };
    s = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_SetInputCallback,
                              kAudioUnitScope_Global, 0, &cb, sizeof(cb));
    if (s != noErr) {
      AudioConverterDispose(converter);
      AudioComponentInstanceDispose(unit);
      err = "SetInputCallback failed";
      return false;
    }

    s = AudioUnitInitialize(unit);
    if (s != noErr) {
      AudioConverterDispose(converter);
      AudioComponentInstanceDispose(unit);
      err = "AudioUnitInitialize failed";
      return false;
    }

    // Pre-allocate the AudioBufferList for AudioUnitRender. AUHAL emits one
    // contiguous mono buffer (we forced kChannelsPerFrame=1 above, or the
    // device's count). We allocate generously and resize lazily if a render
    // frame is larger than the current capacity.
    const UInt32 initialCapacity = 4096; // frames; ~85 ms @ 48 kHz, plenty
    AllocRenderBufferList(unitOutputFormat, initialCapacity);

    ctx_->auHal = unit;
    ctx_->converter = converter;
    ctx_->currentDeviceID = deviceID;

    s = AudioOutputUnitStart(unit);
    if (s != noErr) {
      err = "AudioOutputUnitStart failed";
      AudioUnitUninitialize(unit);
      AudioConverterDispose(converter);
      AudioComponentInstanceDispose(unit);
      FreeRenderBufferList();
      ctx_->auHal = nullptr;
      ctx_->converter = nullptr;
      return false;
    }
    ctx_->started.store(true);
    return true;
  }

  /** Stop + dispose + reopen on a new device. Used by both the system-default
   *  listener and the user-driven setDevice path. Emits 'rebound' / 'error'
   *  via the JS callbacks. Runs on rebindQueue (NOT the audio thread). */
  void RebindToDevice(AudioObjectID newDeviceID, std::string &err) {
    if (ctx_->auHal) {
      AudioOutputUnitStop(ctx_->auHal);
      AudioUnitUninitialize(ctx_->auHal);
      AudioComponentInstanceDispose(ctx_->auHal);
      ctx_->auHal = nullptr;
    }
    if (ctx_->converter) {
      AudioConverterDispose(ctx_->converter);
      ctx_->converter = nullptr;
    }
    FreeRenderBufferList();
    ctx_->started.store(false);

    std::string openErr;
    if (!OpenAndStartUnit(newDeviceID, openErr)) {
      err = openErr;
      EmitError(openErr.c_str());
      return;
    }
    EmitRebound();
  }

  void StopInternal() {
    if (!ctx_) return;
    if (ctx_->defaultListenerInstalled) {
      AudioObjectPropertyAddress addr = {
          kAudioHardwarePropertyDefaultInputDevice,
          kAudioObjectPropertyScopeGlobal,
          kAudioObjectPropertyElementMain
      };
      AudioObjectRemovePropertyListener(kAudioObjectSystemObject, &addr,
                                         DefaultDeviceChanged, ctx_);
      ctx_->defaultListenerInstalled = false;
    }
    if (ctx_->auHal) {
      AudioOutputUnitStop(ctx_->auHal);
      AudioUnitUninitialize(ctx_->auHal);
      AudioComponentInstanceDispose(ctx_->auHal);
      ctx_->auHal = nullptr;
    }
    if (ctx_->converter) {
      AudioConverterDispose(ctx_->converter);
      ctx_->converter = nullptr;
    }
    FreeRenderBufferList();
    ctx_->started.store(false);
  }

  // ─── Render-buffer pool helpers ───────────────────────────────────────

  void AllocRenderBufferList(const AudioStreamBasicDescription &fmt,
                             UInt32 frameCapacity) {
    FreeRenderBufferList();
    const UInt32 byteCapacity = frameCapacity * fmt.mBytesPerFrame;
    // AudioBufferList is a flexible-array struct; one mBuffer is included in
    // sizeof(AudioBufferList). We use one buffer because we forced mono (or
    // multi-channel-interleaved when downmix wasn't accepted), so the data
    // is in a single contiguous buffer regardless.
    AudioBufferList *abl = (AudioBufferList *)calloc(1, sizeof(AudioBufferList));
    abl->mNumberBuffers = 1;
    abl->mBuffers[0].mNumberChannels = fmt.mChannelsPerFrame;
    abl->mBuffers[0].mDataByteSize = byteCapacity;
    abl->mBuffers[0].mData = malloc(byteCapacity);
    ctx_->renderBufferList = abl;
    ctx_->renderBufferCapacity = frameCapacity;
  }

  void FreeRenderBufferList() {
    if (!ctx_->renderBufferList) return;
    if (ctx_->renderBufferList->mBuffers[0].mData) {
      free(ctx_->renderBufferList->mBuffers[0].mData);
    }
    free(ctx_->renderBufferList);
    ctx_->renderBufferList = nullptr;
    ctx_->renderBufferCapacity = 0;
  }

  // ─── Emit helpers ─────────────────────────────────────────────────────

  void EmitError(const char *messagePtr) {
    if (!ctx_->onError) return;
    std::string msg(messagePtr);
    ctx_->onError.BlockingCall([msg](Napi::Env env, Napi::Function jsCallback) {
      jsCallback.Call({Napi::String::New(env, msg)});
    });
  }
  void EmitRebound() {
    if (!ctx_->onRebound) return;
    ctx_->onRebound.BlockingCall([](Napi::Env env, Napi::Function jsCallback) {
      jsCallback.Call({});
    });
  }

 public:
  // Render-proc callback target (declared friend-style by storing Ctx*).
  friend OSStatus InputProc(void *, AudioUnitRenderActionFlags *,
                             const AudioTimeStamp *, UInt32, UInt32,
                             AudioBufferList *);
  friend OSStatus DefaultDeviceChanged(AudioObjectID, UInt32,
                                        const AudioObjectPropertyAddress *,
                                        void *);
};

// ─── Audio-thread input proc ────────────────────────────────────────────

// State for the converter input callback (per-render). We feed AudioConverter
// the exact buffer we just pulled via AudioUnitRender, marked one-shot so
// the converter doesn't re-ask after we've handed it everything.
struct ConverterInputState {
  AudioBufferList *inputBuffers;
  UInt32 framesRemaining;
  AudioStreamBasicDescription format;
};

static OSStatus ConverterInputProc(AudioConverterRef inConverter,
                                   UInt32 *ioNumberDataPackets,
                                   AudioBufferList *ioData,
                                   AudioStreamPacketDescription **outDataPacketDescription,
                                   void *inUserData) {
  ConverterInputState *st = (ConverterInputState *)inUserData;
  if (st->framesRemaining == 0) {
    *ioNumberDataPackets = 0;
    return noErr;
  }
  UInt32 supply = std::min<UInt32>(*ioNumberDataPackets, st->framesRemaining);
  // Point the converter at our (already-filled) input buffer. The converter
  // will read directly from it.
  ioData->mNumberBuffers = st->inputBuffers->mNumberBuffers;
  for (UInt32 i = 0; i < ioData->mNumberBuffers; i++) {
    ioData->mBuffers[i].mNumberChannels = st->inputBuffers->mBuffers[i].mNumberChannels;
    ioData->mBuffers[i].mDataByteSize = supply * st->format.mBytesPerFrame;
    ioData->mBuffers[i].mData = st->inputBuffers->mBuffers[i].mData;
  }
  *ioNumberDataPackets = supply;
  st->framesRemaining = 0; // one-shot
  if (outDataPacketDescription) *outDataPacketDescription = nullptr;
  return noErr;
}

static OSStatus InputProc(void *inRefCon,
                          AudioUnitRenderActionFlags *ioActionFlags,
                          const AudioTimeStamp *inTimeStamp,
                          UInt32 inBusNumber,
                          UInt32 inNumberFrames,
                          AudioBufferList *ioData) {
  (void)ioData; // input scope — AUHAL passes nullptr here on input bus.
  Ctx *ctx = (Ctx *)inRefCon;
  if (!ctx || !ctx->auHal) return noErr;

  // Resize our render buffer if the device hands us a larger block than
  // what we pre-allocated. Allocation on the audio thread is non-ideal but
  // (a) only happens once per device that gives bigger frames than 4096,
  // and (b) free()/malloc() are bounded — better than dropping samples.
  if (inNumberFrames > ctx->renderBufferCapacity) {
    if (ctx->renderBufferList && ctx->renderBufferList->mBuffers[0].mData) {
      free(ctx->renderBufferList->mBuffers[0].mData);
    }
    const UInt32 bytes = inNumberFrames * ctx->inputFormat.mBytesPerFrame;
    ctx->renderBufferList->mBuffers[0].mData = malloc(bytes);
    ctx->renderBufferList->mBuffers[0].mDataByteSize = bytes;
    ctx->renderBufferCapacity = inNumberFrames;
  } else {
    ctx->renderBufferList->mBuffers[0].mDataByteSize =
        inNumberFrames * ctx->inputFormat.mBytesPerFrame;
  }

  OSStatus s = AudioUnitRender(ctx->auHal, ioActionFlags, inTimeStamp,
                                inBusNumber, inNumberFrames,
                                ctx->renderBufferList);
  if (s != noErr) {
    // Most likely cause: pinned device disappeared. Surface a distinguishable
    // message so the orchestrator can pause-by-device-loss vs generic error.
    if (ctx->onError) {
      const char *m = "device_disappeared";
      std::string msg(m);
      ctx->onError.BlockingCall([msg](Napi::Env env, Napi::Function jsCallback) {
        jsCallback.Call({Napi::String::New(env, msg)});
      });
    }
    return s;
  }

  // Convert to 16 kHz int16 mono. Output size is bounded by
  // inNumberFrames * target.rate / input.rate + slack.
  const Float64 ratio = ctx->targetFormat.mSampleRate / ctx->inputFormat.mSampleRate;
  const UInt32 outFrameEstimate = (UInt32)((Float64)inNumberFrames * ratio + 32);
  const UInt32 outBytes = outFrameEstimate * ctx->targetFormat.mBytesPerFrame;
  void *outData = malloc(outBytes);
  if (!outData) return noErr;

  AudioBufferList outABL;
  outABL.mNumberBuffers = 1;
  outABL.mBuffers[0].mNumberChannels = kTargetChannels;
  outABL.mBuffers[0].mDataByteSize = outBytes;
  outABL.mBuffers[0].mData = outData;

  ConverterInputState inState = {
      ctx->renderBufferList, inNumberFrames, ctx->inputFormat
  };
  UInt32 outFrames = outFrameEstimate;
  OSStatus cs = AudioConverterFillComplexBuffer(
      ctx->converter, ConverterInputProc, &inState, &outFrames, &outABL, nullptr);
  if (cs != noErr) {
    free(outData);
    return noErr;
  }

  const size_t finalBytes = outFrames * ctx->targetFormat.mBytesPerFrame;
  if (finalBytes == 0) { free(outData); return noErr; }

  if (ctx->onPcm) {
    uint8_t *send = (uint8_t *)outData;
    ctx->onPcm.BlockingCall([send, finalBytes](Napi::Env env, Napi::Function jsCallback) {
      // Why Copy instead of New(external): node-addon-api v8 + Node 22+
      // (which Electron 36 ships) reject external buffers in the TSFN path;
      // every BlockingCall throws and the frame is dropped.
      Napi::Buffer<uint8_t> buf = Napi::Buffer<uint8_t>::Copy(env, send, finalBytes);
      free(send);
      jsCallback.Call({buf});
    });
  } else {
    free(outData);
  }
  return noErr;
}

// ─── Default-device-change listener ─────────────────────────────────────

static OSStatus DefaultDeviceChanged(AudioObjectID inObjectID,
                                     UInt32 inNumberAddresses,
                                     const AudioObjectPropertyAddress *inAddresses,
                                     void *inClientData) {
  (void)inObjectID; (void)inNumberAddresses; (void)inAddresses;
  Ctx *ctx = (Ctx *)inClientData;
  if (!ctx || !ctx->followingSystemDefault || !ctx->rebindQueue) return noErr;

  // Hop onto our rebind queue so we never reconfigure the AudioUnit from a
  // CoreAudio-owned thread. Capture the device ID by value at fire time.
  AudioObjectID newDefault = GetDefaultInputDeviceID();
  if (newDefault == kAudioObjectUnknown || newDefault == ctx->currentDeviceID) {
    return noErr;
  }
  dispatch_async(ctx->rebindQueue, ^{
    if (!ctx->followingSystemDefault) return; // raced with setDevice
    AudioObjectID confirm = GetDefaultInputDeviceID();
    if (confirm == kAudioObjectUnknown) return;
    if (confirm == ctx->currentDeviceID) return;

    if (ctx->auHal) {
      AudioOutputUnitStop(ctx->auHal);
      AudioUnitUninitialize(ctx->auHal);
      AudioComponentInstanceDispose(ctx->auHal);
      ctx->auHal = nullptr;
    }
    if (ctx->converter) {
      AudioConverterDispose(ctx->converter);
      ctx->converter = nullptr;
    }
    if (ctx->renderBufferList) {
      if (ctx->renderBufferList->mBuffers[0].mData) {
        free(ctx->renderBufferList->mBuffers[0].mData);
      }
      free(ctx->renderBufferList);
      ctx->renderBufferList = nullptr;
      ctx->renderBufferCapacity = 0;
    }
    ctx->started.store(false);

    // Re-open with the new default. We can't call OpenAndStartUnit (instance
    // method) from a free function — inline the equivalent here. The full
    // method body is in MicCapture::OpenAndStartUnit; this mirrors it.
    // To keep this in one place, the listener fires a generic 'error' on
    // failure and 'rebound' on success — the orchestrator already handles
    // both.
    AudioComponentDescription desc = {
        kAudioUnitType_Output,
        kAudioUnitSubType_HALOutput,
        kAudioUnitManufacturer_Apple, 0, 0
    };
    AudioComponent comp = AudioComponentFindNext(nullptr, &desc);
    AudioUnit unit = nullptr;
    if (!comp || AudioComponentInstanceNew(comp, &unit) != noErr || !unit) {
      if (ctx->onError) {
        std::string msg = "rebind_failed";
        ctx->onError.BlockingCall([msg](Napi::Env env, Napi::Function jsCallback) {
          jsCallback.Call({Napi::String::New(env, msg)});
        });
      }
      return;
    }
    UInt32 enable = 1, disable = 0;
    AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO,
                         kAudioUnitScope_Input, 1, &enable, sizeof(enable));
    AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO,
                         kAudioUnitScope_Output, 0, &disable, sizeof(disable));
    OSStatus s = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                                       kAudioUnitScope_Global, 0,
                                       &confirm, sizeof(confirm));
    if (s != noErr) { AudioComponentInstanceDispose(unit); return; }

    AudioStreamBasicDescription deviceFormat = {};
    UInt32 propSize = sizeof(deviceFormat);
    s = AudioUnitGetProperty(unit, kAudioUnitProperty_StreamFormat,
                              kAudioUnitScope_Input, 1, &deviceFormat, &propSize);
    if (s != noErr) { AudioComponentInstanceDispose(unit); return; }

    AudioStreamBasicDescription unitOut = {};
    unitOut.mSampleRate = deviceFormat.mSampleRate;
    unitOut.mFormatID = kAudioFormatLinearPCM;
    unitOut.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
    unitOut.mBytesPerPacket = sizeof(Float32);
    unitOut.mFramesPerPacket = 1;
    unitOut.mBytesPerFrame = sizeof(Float32);
    unitOut.mChannelsPerFrame = 1;
    unitOut.mBitsPerChannel = 32;
    s = AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat,
                              kAudioUnitScope_Output, 1, &unitOut, sizeof(unitOut));
    if (s != noErr) {
      unitOut.mChannelsPerFrame = deviceFormat.mChannelsPerFrame;
      unitOut.mBytesPerPacket = sizeof(Float32) * unitOut.mChannelsPerFrame;
      unitOut.mBytesPerFrame  = sizeof(Float32) * unitOut.mChannelsPerFrame;
      s = AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat,
                                kAudioUnitScope_Output, 1, &unitOut, sizeof(unitOut));
      if (s != noErr) { AudioComponentInstanceDispose(unit); return; }
    }
    ctx->inputFormat = unitOut;

    AudioStreamBasicDescription target = {};
    target.mSampleRate = kTargetSampleRate;
    target.mFormatID = kAudioFormatLinearPCM;
    target.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
    target.mBytesPerPacket = sizeof(int16_t);
    target.mFramesPerPacket = 1;
    target.mBytesPerFrame  = sizeof(int16_t);
    target.mChannelsPerFrame = 1;
    target.mBitsPerChannel = 16;
    ctx->targetFormat = target;

    AudioConverterRef converter = nullptr;
    if (AudioConverterNew(&unitOut, &target, &converter) != noErr) {
      AudioComponentInstanceDispose(unit);
      return;
    }
    AURenderCallbackStruct cb = { InputProc, ctx };
    AudioUnitSetProperty(unit, kAudioOutputUnitProperty_SetInputCallback,
                         kAudioUnitScope_Global, 0, &cb, sizeof(cb));
    if (AudioUnitInitialize(unit) != noErr) {
      AudioConverterDispose(converter);
      AudioComponentInstanceDispose(unit);
      return;
    }
    const UInt32 cap = 4096;
    AudioBufferList *abl = (AudioBufferList *)calloc(1, sizeof(AudioBufferList));
    abl->mNumberBuffers = 1;
    abl->mBuffers[0].mNumberChannels = unitOut.mChannelsPerFrame;
    abl->mBuffers[0].mDataByteSize = cap * unitOut.mBytesPerFrame;
    abl->mBuffers[0].mData = malloc(abl->mBuffers[0].mDataByteSize);
    ctx->renderBufferList = abl;
    ctx->renderBufferCapacity = cap;

    ctx->auHal = unit;
    ctx->converter = converter;
    ctx->currentDeviceID = confirm;
    if (AudioOutputUnitStart(unit) == noErr) {
      ctx->started.store(true);
      if (ctx->onRebound) {
        ctx->onRebound.BlockingCall([](Napi::Env env, Napi::Function jsCallback) {
          jsCallback.Call({});
        });
      }
    }
  });
  return noErr;
}

}  // namespace

Napi::Object InitMicCapture(Napi::Env env, Napi::Object exports) {
  MicCapture::Init(env, exports);
  exports.Set("listInputDevices", Napi::Function::New(env, ListInputDevices));
  return exports;
}
