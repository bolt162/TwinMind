# @twinmind/coreaudio-darwin

Native macOS audio bindings for TwinMind V2:

- **`micCapture()`** — `AVAudioEngine` tap on the default input device, converted to 16 kHz mono int16 PCM and emitted on the audio thread via N-API thread-safe functions. Mirrors `ICapture` in `src/audio-process/IMicCapture.ts`.
- **`micMonitor()`** — `kAudioDevicePropertyDeviceIsRunningSomewhere` listener on the current default input. Fires `started` / `stopped` whenever **any** process on the system opens or releases the mic. No TCC prompt required.

Both classes live in this one addon to halve the build/CI matrix vs shipping two packages (see architecture §3 / §6).

## Build

```bash
cd native/coreaudio-darwin
npm install        # builds via node-gyp; needs Xcode CLT
```

The binary is written to `build/Release/coreaudio_darwin.node`. `index.js` `require()`s it lazily.

### Requirements

- macOS 14.2+ (matches `MACOSX_DEPLOYMENT_TARGET` in `binding.gyp`)
- Xcode Command Line Tools (`xcode-select --install`)
- Python 3 (`node-gyp` dep)

### Rebuilding

```bash
npm run rebuild      # node-gyp clean + configure + build
```

For Electron-targeted builds (production), invoke from the parent project:

```bash
npm run rebuild:electron     # runs electron-builder install-app-deps
```

## Status

The code compiles cleanly under Xcode 15 on both Apple Silicon and Intel toolchains. **End-to-end audio capture has not been validated against real microphones** as part of this scaffold — the V2 architecture doc explicitly flags the native layer for on-device QA. Most likely tweak surface: AVAudioConverter chunking, buffer-size selection in the tap block (currently `4096` frames).

If a build fails or the binary fails to load, the audio-process surfaces a clear error at start. Tests bypass this addon entirely by setting `TWINMIND_MIC_BACKEND=mock`.
