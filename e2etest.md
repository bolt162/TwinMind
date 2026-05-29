# TwinMind E2E Test Suite — Specs and Flows

17 specs, 8 phases. Source: `tests/e2e/*.spec.ts`. Build prereq: `npm run build:e2e` (bakes `.env.test` into the bundle). Run: `npm run test:e2e:nobuild`.

---

## Phase 1 — Smoke (`smoke.spec.ts`)
**No sign-in required.** Verifies the e2e harness itself.

### 1. boots to the sign-in screen on a fresh userData dir
```
launch Electron (tmp userData) → assert SignInScreen visible
  → diagnostics: auth.isAuthenticated=false, composedUserId=null,
    orchestrator.state=idle
```

### 2. e2e permission hook is wired and mutable
```
launch → setPermission('mic', 'denied') via globalThis.__e2e
  → diagnostics: permissions.mic='denied', others='granted'
```

---

## Phase 2 — Auth (`auth.spec.ts`)

### A1. cold sign-in lands on the onboarding wizard
```
launch (fresh userData) → click [data-testid=sign-in-button]
  → auth provider opens dev webapp URL (intercepted by globalThis.__e2eLastAuthBrowserUrl)
  → OAuth helper drives separate Chromium:
       navigate to https://dev.app.twinmind.com/login?via_desktop&x-vercel-bypass=…
       fill [data-testid=test-user-secret-input] with TWINMIND_E2E_TEST_SECRET
       click [data-testid=test-user-button]
       capture twinmind:// redirect
  → deliverAuthCallback(url) feeds it back to app.on('open-url')
  → auth provider exchanges code → Firebase signInWithCustomToken
  → assert OnboardingFlow visible, SignInScreen gone
  → diagnostics: isAuthenticated=true, userEmail set, composedUserId=auth.userId
```

### A2. sign-out from Settings returns to the sign-in screen
```
completeWizard() (DB-only flag) → signIn → land directly on main layout
  → click [data-testid=tab-settings] → click [data-testid=sign-out-button]
  → assert SignInScreen visible
  → diagnostics: isAuthenticated=false, composedUserId=null
```

### A3. relaunch with persisted credentials skips the sign-in screen
```
launch #1 (keepUserDataDir) → signIn → completeWizard → diagnostics confirm auth
  → relaunch() reuses same userData dir
launch #2 → auth provider rehydrates refresh-token from Keychain
  → assert app-layout visible, SignInScreen never mounts
  → diagnostics: same userId as launch #1
```

---

## Phase 3 — Onboarding (`onboarding.spec.ts`)

### B1. walks every wizard step → main app + visible HUD
```
signIn → land on OnboardingFlow (data-onboarding-step="welcome")
  → click onboarding-welcome-next → step="mic"
  → click onboarding-mic-next → step="audioCapture"
  → click onboarding-audiocap-next → step="accessibility"
  → click onboarding-accessibility-next → step="notifications"
  → click onboarding-notifications-next → step="done"
  → click onboarding-done-button
  → assert app-layout visible, OnboardingFlow gone
  → assert tab-recording has data-active="true"
  → assert HUD BrowserWindow isVisible() === true
```

### B2. wizard does not re-run on subsequent sign-ins (same machine)
```
signIn #1 (fresh) → OnboardingFlow visible
  → walkOnboardingWizard() (clicks through every step)
  → app-layout visible
  → tab-settings → sign-out-button → SignInScreen
signIn #2 (same machine, globalDb.onboarding_completed_at persists)
  → app-layout visible directly, OnboardingFlow NEVER mounts
```

---

## Phase 4 — Settings (`settings.spec.ts`)

### C1. toggle persists across tab navigation
```
completeWizard → signIn → tab-settings
  → assert settings-meeting-detect-enabled aria-checked=true (default)
  → assert settings-meeting-detect-autostart aria-checked=false (default)
  → click both toggles → assert flipped
  → tab-recording (forces SettingsPage unmount)
  → tab-settings (re-mounts, useSettings refetches from DB)
  → assert toggles still in the flipped state
```

### C2. changing hotkey via settings updates the Home page hint
```
completeWizard → signIn → land on Home tab
  → assert [data-testid=home-hotkey-label] reads "🌐 Fn" (default)
  → page.evaluate: settings.set({ hotkeys: { primary: { modifiers:['MetaLeft','ShiftLeft'], key:{code:'KeyD',display:'D'} }}})
  → main broadcasts HOTKEY_CHANGED push
  → assert label reads "Left ⌘ + Left ⇧ + D"
```

---

## Phase 5 — HUD (`hud.spec.ts`)

### D1. drag shifts HUD window bounds via IPC
```
completeWizard → signIn
  → snapshot HUD BrowserWindow getBounds() → {x, y, w, h}
  → from HUD page: hud.beginDrag() → hud.dragMoveBy({dx:60, dy:-40}) → hud.endDrag()
  → re-read getBounds() → assert x and y changed
```

### D2. pill transitions through recording states for a meeting
```
completeWizard → signIn
  → assert [data-testid=hud-pill] data-hud-visual="idle", data-hud-recording="idle"
  → main.evaluate: recording.startMeeting()
  → assert pill data-hud-recording="recording", data-hud-mode="meeting", data-hud-visual="recording"
  → main.evaluate: recording.stopMeeting({ sessionId })
  → assert pill data-hud-recording back to "idle"
```

---

## Phase 6 — Recording (`recording.spec.ts`)
**All three use `micBackend: 'mock_sine'`** so the audio-process emits a 440 Hz tone (not silence) → ChunkWriter's VAD lets the chunk through → MockAsrClient returns `"(mock transcript)"`.

### E1. dictation hotkey hold/release produces a tile in Dictations
```
completeWizard → signIn
  → main.evaluate: recording.startDictation()
  → wait 800 ms (audio captured)
  → main.evaluate: recording.stopDictation()
  → chunk encoded (ffmpeg) → uploaded to MockAsrClient → transcript saved
  → tab-dictations → assert at least one [data-testid=dictation-tile] visible
```

### F1. meeting start/stop creates a row in the Meetings tab
```
completeWizard → signIn
  → recording.startMeeting() → diagnostics.orchestrator.sessionId captured
  → wait 800 ms
  → recording.stopMeeting({ sessionId })
  → tab-meetings
  → assert [data-testid=session-row][data-session-id=<id>] visible
  → assert data-session-mode="meeting"
```

### F2. opening a meeting row mounts SessionDetail with the session id
```
completeWizard → signIn → start/stop meeting like F1
  → tab-meetings → click the session row
  → assert [data-testid=session-detail] visible
  → assert data-session-id matches the captured sessionId
  → assert [data-testid=session-detail-back] visible
```

---

## Phase 7 — Sessions / Transcripts (`sessions.spec.ts`)
**Both use `micBackend: 'mock_sine'`** for the same reason as Phase 6.

### G1. row Copy button writes the transcript to the clipboard
```
completeWizard → signIn → start/stop meeting (1.5 s of sine)
  → tab-meetings → wait for the row's [data-testid=session-row-copy-button]
    to become enabled (gated on hasText, which flips true once the chunk's
    transcript lands in DB)
  → click Copy
  → read clipboard via electron.clipboard.readText() (main process)
  → assert clipboard contains "(mock transcript)"
```

### G2. SessionDetail renders the chunk transcript text
```
completeWizard → signIn → start/stop meeting
  → tab-meetings → click the row
  → assert [data-testid=session-detail] visible
  → assert [data-testid=transcript-chunk-text] text equals "(mock transcript)"
```

---

## Phase 8 — Auto-updater (`updater.spec.ts`)

### H1. update banner appears with the forced version and is clickable
```
completeWizard → signIn → land on Home
  → assert update-banner has count 0 (sanity)
  → forceUpdateReady('1.0.99') via globalThis.__e2e (UpdateService is
    `disabled` in unpackaged e2e runs, so the real electron-updater path
    never fires; we push the state directly)
  → assert [data-testid=update-banner] visible, data-update-version="1.0.99"
  → assert banner text contains "1.0.99"
  → assert [data-testid=update-install-button] is enabled and clickable
```

---

# Skips / Bypasses / Fakes — What's NOT real in tests

This is the honest list, for review.

## 1. `test.skip` (whole-suite gate)

Every spec begins with:

```ts
test.skip(!HAS_SECRET, 'TWINMIND_E2E_TEST_SECRET not set');
```

If `.env.test` doesn't include the dev test secret, **every spec auto-skips**. No silent failures — they show as `-` (skipped) in the report. This is the only `test.skip` in the codebase.

## 2. `TWINMIND_E2E=1` master switch

When set, three things happen in source that wouldn't in prod:

| Production | E2E mode |
|---|---|
| `DarwinPermissionService` (real macOS TCC prompts) | `FakePermissionService` — in-memory `{mic, audioCapture, accessibility, notifications}` all pre-set to `'granted'` |
| `DarwinPasteService` (real keystroke synthesis) | `FakePasteService` — records `lastText`, no OS-level keystrokes |
| `openBrowser(url) → shell.openExternal(url)` | `openBrowser(url) → globalThis.__e2eLastAuthBrowserUrl = url` (intercepted so Playwright can drive a separate Chromium to that URL) |

**Why**: macOS TCC permissions are OS-level modals Playwright can't see; real keystroke synthesis would type into whatever editor is focused on your machine; `shell.openExternal` would open Chrome and we'd lose control of the OAuth flow.

## 3. Audio mocked (`TWINMIND_MIC_BACKEND`)

| Value | Use |
|---|---|
| `mock` (default) | `MockMicCapture.silence()` — all-zero PCM. Used by Phases 1-5, 8 (no transcript content needed). |
| `mock_sine` | `MockMicCapture.sine()` — 440 Hz wave. Used by Phases 6 + 7 so VAD doesn't skip chunks and `(mock transcript)` lands in DB. |

No real CoreAudio capture happens during tests. The orchestrator + chunk-writer + audio-process pipeline run identically — they just receive synthetic PCM.

## 4. ASR mocked (`TWINMIND_ASR_PROVIDER=mock`)

`MockAsrClient` returns the string `"(mock transcript)"` synchronously for every chunk. **No real network call to the transcription endpoint.** The `UploadQueue` runs unchanged — same retry policy, same chunk_completed events, same DB writes.

## 5. Real services we DO hit

The e2e tests are not fully hermetic — these calls go out to the real dev environment:

| Surface | Endpoint | When |
|---|---|---|
| Dev webapp UI | `https://dev.app.twinmind.com/login?via_desktop` | Every sign-in spec (A1, A2, A3, B1, B2, C1, C2, D2, E1, F1, F2, G1, G2, H1) |
| TwinMind exchange | `https://dev.twinmind.com/api/auth/exchange-web-handoff` | Sign-in code → Firebase customToken |
| Firebase REST | `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken` | Custom token → ID + refresh token |
| Firebase REST | `https://securetoken.googleapis.com/v1/token` | Refresh-token rotation when tests relaunch |
| Summary endpoint | `https://dev.twinmind.com/api/summary` | Fires automatically on meeting end if transcripts exist (F1, F2, G1, G2). We don't assert against its response — it's a fire-and-forget side effect of the spec. |

Sign-in itself is real OAuth, just authenticating via the dev webapp's password field instead of Google so we avoid 2FA / captcha in headless Chromium.

## 6. Auto-updater short-circuit

`UpdateService` self-disables when `!app.isPackaged`. Our tests launch from `dist/main/main.js` (not a `.app` bundle), so `app.isPackaged === false`, `disabled === true`, and the real `electron-updater` path never runs. H1 uses `globalThis.__e2e.forceUpdateReady(version)` to push the state machine into `ready` directly, then clicks the install button — `quitAndInstall` returns `{ ok: false, error: 'not_ready' }` (still in disabled mode), so the app does NOT actually quit. The test verifies the banner UI renders and is clickable. **The real "Restart & Update quits the app" flow can only be tested against a packaged DMG.**

## 7. Hotkey capture not driven via OS keys

C2 (hotkey re-capture) calls `SETTINGS_SET` directly via IPC to install a new hotkey, instead of synthesizing native `Fn`/`Cmd`/`Shift` key events through Playwright. **macOS Globe (Fn) key events cannot be programmatically injected from a user-space test runner.** The HotkeyGestureRecognizer logic is covered by `tests/unit/HotkeyGestureRecognizer.test.ts`. The e2e test verifies the propagation path: settings write → HOTKEY_CHANGED push → Home page hint refresh.

## 8. UserData isolation

Each spec gets a `mkdtempSync(.../twinmind-e2e-)` directory passed via `TWINMIND_USER_DATA_DIR`. DB, recordings, logs, encrypted-token blobs are all per-spec. Deleted on `app.close()` unless `keepUserDataDir: true` (only A3 uses that, for the relaunch).

## 9. macOS Keychain

`safeStorage` (encrypts the refresh token) is the real one — we don't mock it. Each spec creates a new encrypted blob in its own per-spec DB; the Keychain's "Electron Safe Storage" entry is shared with the user's other Electron apps. This is unavoidable without sandboxing Electron's Keychain access, which isn't supported by `safeStorage`'s API.

---

# Quick reference

- **17 happy-path specs**, all green, ~1.4 min full run.
- **What's real**: sign-in to the dev backend (real OAuth-equivalent + real Firebase token exchange), all renderer logic, all main-process logic, all IPC, the orchestrator + chunk-writer + upload-queue, recovery, settings persistence, HUD window management.
- **What's mocked**: macOS TCC permissions, system keystroke paste, microphone audio (synthetic PCM), ASR transcription (returns fixed string), browser-open intent (captured for the test driver), auto-updater state machine (forced into `ready` for H1).
- **What's not covered yet (deliberately deferred)**: failure modes (network down, rate-limit, bad-audio), device-loss pause/resume, summary content assertions, real Google OAuth path, packaged-DMG auto-update install, native macOS hotkey capture via the Fn key.
- **Skip mechanism**: only `TWINMIND_E2E_TEST_SECRET` missing skips specs. There's no skip flag bypassing assertions inside any spec.

---

# Commands

```bash
# Build bundle from .env.test AND run the full suite (recommended)
npm run test:e2e

# Re-run against the existing build (no rebuild)
npm run test:e2e:nobuild

# Slow every action by 3 seconds for visual inspection
TWINMIND_E2E_SLOWMO=3000 npm run test:e2e:nobuild

# Slow-mo + show the OAuth Chromium window
TWINMIND_E2E_SLOWMO=3000 TWINMIND_E2E_HEADED=1 npm run test:e2e:nobuild

# One spec only
npx playwright test tests/e2e/auth.spec.ts -g "A1"

# View a failed run's trace (auto-captured)
npx playwright show-trace test-results/<spec-name>/trace.zip
```

---

# Required `.env.test` keys

```
# Test-only sign-in secret (gates every spec)
TWINMIND_E2E_TEST_SECRET=<dev test user secret>

# TwinMind dev backend
TWINMIND_BACKEND_URL=https://dev.twinmind.com
TWINMIND_TRANSCRIBE_URL=https://dev.twinmind.com/api/transcribe
TWINMIND_SUMMARY_URL=https://dev.twinmind.com/api/summary
TWINMIND_APP_URL=https://dev.app.twinmind.com
TWINMIND_WEB_LOGIN_URL=https://dev.app.twinmind.com/login?via_desktop
VERCEL_PROTECTION_BYPASS=<dev protection bypass token>

# Firebase dev project (public values per Firebase docs)
FIREBASE_WEB_API_KEY=<dev project>
FIREBASE_TENANT_ID=<dev project tenant id>
FIREBASE_PROJECT_ID=<dev project>
```
