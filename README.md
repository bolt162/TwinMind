# TwinMind

A macOS desktop app for **dictation** and **meeting transcription**.

- **Dictation** — hold a global hotkey, speak, release. Your transcript is pasted into whatever app you were typing in.
- **Meetings** — capture system audio + microphone, get a live transcript, browse past meetings with editable titles.
- Runs locally as a tray app with a small floating HUD.

Transcription is powered by [Groq](https://console.groq.com) (Whisper Large v3). You bring your own API key — it's stored in the macOS Keychain.

---

## Requirements

- macOS 13+ (Apple Silicon or Intel)
- Node.js 20+
- Xcode Command Line Tools (for the native CoreAudio addon)
- A [Groq API key](https://console.groq.com/keys)

---

## Install the prebuilt app

Grab the latest `.dmg` from the [Releases](https://github.com/bolt162/TwinMind/releases) page, drag TwinMind to `/Applications`, and launch it.

On first launch the onboarding flow asks for:

1. **Microphone** access
2. **System Audio Recording** (for meetings)
3. **Accessibility** (for the global hotkey + auto-paste)
4. Your **Groq API key**
5. Your **dictation hotkey** (default: hold `Fn`)

Once onboarding completes, the floating HUD appears. Hold your hotkey anywhere on the system to dictate.

---

## Run from source

```bash
git clone https://github.com/bolt162/TwinMind.git
cd TwinMind
npm install
npm run dev
```

`npm run dev` starts Vite for the renderer, compiles the main + audio processes, and launches Electron.

### Useful scripts

| Script              | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Start the app in dev mode with hot reload     |
| `npm run build`     | Produce a packaged `.dmg` in `release/`       |
| `npm run build:mac` | Same, mac-only                                |
| `npm run test`      | Run the unit + integration test suite         |
| `npm run typecheck` | Type-check main, audio-process, and renderer  |
| `npm run lint`      | Lint with ESLint                              |

### Native addon

The app uses a small native node addon (`native/coreaudio-darwin`) for microphone capture and the `Fn` (Globe) key listener. `npm install` builds it automatically; if you ever switch between running tests (Node ABI) and the app (Electron ABI), use:

```bash
npm run switch:app     # rebuild native modules for Electron
npm run switch:tests   # rebuild native modules for Node (tests)
```

---

## Building a signed + notarized DMG

The build is set up for Developer ID signing and Apple notarization. Set these env vars before `npm run build:mac`:

```bash
export APPLE_ID="your@appleid.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="ABCDE12345"
export CSC_LINK="/path/to/DeveloperID.p12"
export CSC_KEY_PASSWORD="…"
```

If those env vars are missing the build still completes — notarization just gets skipped and you'll have an ad-hoc-signed DMG.

---

## Where things live

- Transcripts, audio chunks, and the SQLite database live under
  `~/Library/Application Support/TwinMind-V2/`
- Logs are at `~/Library/Logs/TwinMind-V2/`
- Your Groq API key lives in the macOS Keychain (`safeStorage`)

To wipe everything, use **Settings → Delete all data** in the app.

---

## License

MIT
