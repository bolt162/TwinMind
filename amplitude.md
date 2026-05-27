Here's what you need to set up this project for Electron-based Mac app analytics:

---

## Setup Overview

This project currently has **no data sources configured**, so you're starting fresh. Here's the full setup path:

### 1. Get Your API Key
Go to **Settings → Projects → [This Project]** and copy the API key — you'll need it for initialization.

### 2. Install the Right SDK (Two Processes)

Electron has two environments, and each needs a different SDK:

**Renderer Process** (UI layer — browser-like):
bash
npm install @amplitude/analytics-browser
ts
import * as amplitude from '@amplitude/analytics-browser';
amplitude.init('YOUR_API_KEY', { defaultTracking: true });

**Main Process** (Node.js layer — system events, app lifecycle):
bash
npm install @amplitude/analytics-node
ts
import { init, track } from '@amplitude/analytics-node';
init('YOUR_API_KEY');
track('App Launched', { version: app.getVersion() });

### 3. Key Configuration for Mac Desktop

**defaultTracking: true** in the renderer — auto-captures page views, clicks, and sessions
**App version**: Pass app.getVersion() as a property on key events so you can filter by release
**User identity**: Call amplitude.setUserId(userId) once the user logs in (your apple| / google| prefixed IDs work perfectly here); anonymous users will be tracked by device ID automatically
**Offline support**: The Node SDK queues events locally if the network is unavailable — good for a desktop app

### 4. Key Events to Track from Day 1

For a Mac app, prioritize:
App Launched / App Quit (main process)
Recording Started / Recording Ended (your core MeetingStarted/MeetingEnded flow)
Error Occurred with error type/message (critical for reliability monitoring)
Feature Used with feature name (to understand engagement)

### 5. Verify Data is Flowing

After integrating, go to **Events** in this project and watch for incoming events within a few minutes of running the app. You can also use the **User Lookup** tool to find your own device and confirm events are arriving correctly.

---

amplitude api key:
757c07dc1d6420ba03b732f8f8560030