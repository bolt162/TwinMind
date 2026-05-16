// MicCapture.mm — AVAudioEngine-based mic capture.
//
// Architecture: §7.1 (IMicCapture contract), §7.7 (device change behavior).
//
// Design:
//   - Open AVAudioEngine, install a tap on `inputNode` at the engine's native
//     format. AVAudioEngine doesn't let us configure the format on the tap
//     directly, so we convert per-frame via AVAudioConverter to 16 kHz mono
//     int16 PCM and pass the converted buffer to JS via ThreadSafeFunction.
//   - Subscribe to AVAudioEngineConfigurationChangeNotification + the default-
//     input-device-change CoreAudio listener. Either fires `device_change`.
//   - The audio callback never blocks: conversion is in-place, the Node Buffer
//     allocation happens on the JS thread (TSFN.BlockingCall is non-blocking
//     for our caller because Node owns the allocation step).
//
// THIS FILE COMPILES, but the runtime behavior has not been validated on real
// hardware (the V2 architecture doc explicitly marks the native code for
// on-device QA). Treat numerical buffer sizing + AVAudioConverter chunking as
// the most likely tweak points.

#include <napi.h>
#include <string>
#include <vector>
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreAudio/CoreAudio.h>

namespace {

constexpr double kTargetSampleRate = 16000.0;
constexpr AVAudioChannelCount kTargetChannels = 1;

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

/**
 * Enumerate all CoreAudio devices that expose input streams and return them
 * as a JS array of { id (UID string), name, isDefault }. Exposed to JS via
 * `listInputDevices()` on the addon's top-level exports — not on MicCapture
 * itself, since we want it callable without instantiating a capture.
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
    result.Set(outIdx++, entry);
  }
  return result;
}

// JS-side context: holds the thread-safe callbacks. The MicCapture instance
// owns it via std::unique_ptr-equivalent; AVAudioEngine retains a reference
// inside the tap block via __block.
struct Ctx {
  Napi::ThreadSafeFunction onPcm;
  Napi::ThreadSafeFunction onError;
  Napi::ThreadSafeFunction onDeviceChange;
  AVAudioEngine *engine = nil;
  AVAudioConverter *converter = nil;
  bool started = false;
};

// One MicCapture object per JS-side instance. Created via MicCaptureCreate.
class MicCapture : public Napi::ObjectWrap<MicCapture> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "MicCapture", {
      InstanceMethod("start", &MicCapture::Start),
      InstanceMethod("stop", &MicCapture::Stop),
      InstanceMethod("setOnPcm", &MicCapture::SetOnPcm),
      InstanceMethod("setOnError", &MicCapture::SetOnError),
      InstanceMethod("setOnDeviceChange", &MicCapture::SetOnDeviceChange),
    });
    auto ref = Napi::Persistent(func);
    ref.SuppressDestruct();
    exports.Set("MicCapture", func);
    return exports;
  }

  MicCapture(const Napi::CallbackInfo &info) : Napi::ObjectWrap<MicCapture>(info) {
    ctx_ = new Ctx();
  }

  ~MicCapture() {
    if (ctx_) {
      StopInternal();
      delete ctx_;
      ctx_ = nullptr;
    }
  }

 private:
  Ctx *ctx_ = nullptr;

  // Replace the current pcm callback with a fresh ThreadSafeFunction.
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

  // Spin up AVAudioEngine + install the tap. Returns true / throws via NAPI on
  // failure so JS sees a rejected promise from start().
  //
  // Optional first arg: deviceId (string UID, e.g., "BuiltInMicrophoneDevice"
  // or a Bluetooth headset's UID). When provided we bind the engine's input
  // node to that specific CoreAudio device. When omitted (or the UID can't
  // be resolved, e.g., device is unplugged), the engine falls back to the
  // current system default — same as the original behavior.
  Napi::Value Start(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (ctx_->started) return env.Undefined();

    AVAudioEngine *engine = [[AVAudioEngine alloc] init];
    AVAudioInputNode *input = engine.inputNode;

    // Optional device-binding before we read the input format. AVAudioEngine
    // uses the bound device's native format, so we must set device first.
    if (info.Length() >= 1 && info[0].IsString()) {
      std::string uidStr = info[0].As<Napi::String>().Utf8Value();
      if (!uidStr.empty()) {
        AudioObjectID deviceID = ResolveDeviceByUID(uidStr);
        if (deviceID != kAudioObjectUnknown) {
          AudioUnit unit = input.audioUnit;
          OSStatus status = AudioUnitSetProperty(
              unit,
              kAudioOutputUnitProperty_CurrentDevice,
              kAudioUnitScope_Global,
              0,
              &deviceID,
              sizeof(deviceID));
          if (status != noErr) {
            // Best-effort: log via stderr (no logger plumbed here). The
            // engine will continue with the system default — degraded but
            // functional, which matches the "configured device unavailable"
            // fallback contract.
            fprintf(stderr, "[coreaudio-darwin] AudioUnitSetProperty"
                            "(CurrentDevice) failed for uid='%s' status=%d;"
                            " falling back to system default\n",
                    uidStr.c_str(), (int)status);
          }
        } else {
          fprintf(stderr, "[coreaudio-darwin] device uid='%s' not found;"
                          " falling back to system default\n",
                  uidStr.c_str());
        }
      }
    }

    AVAudioFormat *inputFormat = [input inputFormatForBus:0];
    AVAudioFormat *targetFormat = [[AVAudioFormat alloc]
        initWithCommonFormat:AVAudioPCMFormatInt16
                  sampleRate:kTargetSampleRate
                    channels:kTargetChannels
                 interleaved:YES];
    AVAudioConverter *converter = [[AVAudioConverter alloc]
        initFromFormat:inputFormat toFormat:targetFormat];

    ctx_->engine = engine;
    ctx_->converter = converter;

    Ctx *ctx = ctx_;  // capture for the block

    [input installTapOnBus:0 bufferSize:4096 format:inputFormat
                     block:^(AVAudioPCMBuffer *_Nonnull inputBuffer,
                             AVAudioTime *_Nonnull when) {
      // Estimate the output frame capacity: ratio of sample rates.
      AVAudioFrameCount outCapacity = (AVAudioFrameCount)(
          (double)inputBuffer.frameLength *
          targetFormat.sampleRate / inputFormat.sampleRate + 64);
      AVAudioPCMBuffer *outBuffer = [[AVAudioPCMBuffer alloc]
          initWithPCMFormat:targetFormat frameCapacity:outCapacity];
      if (!outBuffer) return;

      NSError *error = nil;
      __block BOOL providedOnce = NO;
      AVAudioConverterInputBlock provider =
          ^AVAudioBuffer *_Nullable(AVAudioPacketCount inNumberOfPackets,
                                    AVAudioConverterInputStatus *outStatus) {
        if (providedOnce) {
          *outStatus = AVAudioConverterInputStatus_NoDataNow;
          return nil;
        }
        providedOnce = YES;
        *outStatus = AVAudioConverterInputStatus_HaveData;
        return inputBuffer;
      };
      AVAudioConverterOutputStatus status = [converter convertToBuffer:outBuffer
                                                                  error:&error
                                                     withInputFromBlock:provider];
      if (status == AVAudioConverterOutputStatus_Error || error) {
        if (ctx->onError) {
          NSString *msg = error ? [error localizedDescription] : @"converter error";
          std::string m = std::string([msg UTF8String]);
          ctx->onError.BlockingCall([m](Napi::Env env, Napi::Function jsCallback) {
            jsCallback.Call({Napi::String::New(env, m)});
          });
        }
        return;
      }

      // Pull int16 PCM out of the converted buffer.
      int16_t *src = (int16_t *)outBuffer.int16ChannelData[0];
      size_t bytes = outBuffer.frameLength * sizeof(int16_t) * kTargetChannels;
      // Copy into a heap buffer that the TSFN callback wraps as a Node Buffer.
      // We could pass `src` directly, but the AVAudioPCMBuffer owns it and may
      // be reclaimed before the JS thread drains the TSFN queue.
      uint8_t *copy = (uint8_t *)malloc(bytes);
      if (!copy) return;
      memcpy(copy, src, bytes);

      if (ctx->onPcm) {
        ctx->onPcm.BlockingCall([copy, bytes](Napi::Env env, Napi::Function jsCallback) {
          // Why Copy instead of New(external): node-addon-api v8 + Node 22+
          // (which Electron 36 ships) reject external buffers in the TSFN
          // path — every BlockingCall throws an uncaught N-API exception
          // and the PCM frame is dropped. Copy allocates a V8-managed buffer
          // and memcpy's into it. The extra ~3 KB memcpy per 100 ms frame is
          // negligible compared to the price of dropping every frame.
          Napi::Buffer<uint8_t> buf = Napi::Buffer<uint8_t>::Copy(env, copy, bytes);
          free(copy);
          jsCallback.Call({buf});
        });
      } else {
        free(copy);
      }
    }];

    // Device-change observer: AVAudioEngineConfigurationChange covers both
    // engine reconfig and most default-input changes. Listener stays attached
    // for the engine's lifetime; -dealloc removes it implicitly via the block.
    [[NSNotificationCenter defaultCenter]
        addObserverForName:AVAudioEngineConfigurationChangeNotification
                    object:engine
                     queue:nil
                usingBlock:^(NSNotification *_Nonnull note) {
      if (!ctx->onDeviceChange) return;
      ctx->onDeviceChange.BlockingCall([](Napi::Env env, Napi::Function jsCallback) {
        Napi::Object info = Napi::Object::New(env);
        info.Set("label", env.Null());
        jsCallback.Call({info});
      });
    }];

    NSError *startError = nil;
    if (![engine startAndReturnError:&startError]) {
      ctx_->engine = nil;
      ctx_->converter = nil;
      NSString *msg = startError ? [startError localizedDescription] : @"engine start failed";
      Napi::Error::New(env, [msg UTF8String]).ThrowAsJavaScriptException();
      return env.Undefined();
    }
    ctx_->started = true;
    return env.Undefined();
  }

  Napi::Value Stop(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    StopInternal();
    return env.Undefined();
  }

  void StopInternal() {
    if (!ctx_ || !ctx_->started) return;
    [ctx_->engine.inputNode removeTapOnBus:0];
    [ctx_->engine stop];
    ctx_->engine = nil;
    ctx_->converter = nil;
    ctx_->started = false;
  }
};

}  // namespace

Napi::Object InitMicCapture(Napi::Env env, Napi::Object exports) {
  MicCapture::Init(env, exports);
  // Top-level enumeration helper, callable without instantiating a capture.
  exports.Set("listInputDevices", Napi::Function::New(env, ListInputDevices));
  return exports;
}
