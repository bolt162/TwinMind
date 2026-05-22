/**
 * Zod schemas for every IPC channel.
 *
 * Architecture: §12.7 — every channel has a Zod validator on both ends.
 *
 * Conventions:
 *  - Input schemas validate the renderer → main payload BEFORE invoking the
 *    user handler. A failed parse becomes an `IpcValidationError` thrown to
 *    the renderer; never silently coerced.
 *  - Output schemas validate the main → renderer response BEFORE shipping it.
 *    Catches accidental shape drift between handler return types and the
 *    contract declared in `channels.ts`.
 *  - Push schemas validate broadcast payloads at the main-side `broadcast()`
 *    helper. Renderer code subscribes to typed events from a thin preload
 *    wrapper and doesn't re-validate (main is the source of truth).
 *
 * Keep these schemas tight: arrays, lengths, enums, and bounded numbers. The
 * renderer is sandboxed but should never trust a buggy main, and vice versa.
 */

import { z } from 'zod';
import { PUSH, REQUEST } from './channels';

const empty = z.object({}).strict();

const permissionGrant = z.enum(['granted', 'denied', 'not_determined', 'unavailable']);

// ─── PUSH schemas ────────────────────────────────────────────────────────────

const recordingStateChanged = z.object({
  mode: z.enum(['idle', 'dictation', 'meeting']),
  state: z.enum(['starting', 'recording', 'stopping', 'paused_by_sleep', 'ended']),
  sessionId: z.string().min(1).max(64).optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
});

const transcriptSegmentAppended = z.object({
  sessionId: z.string().min(1).max(64),
  chunkId: z.string().min(1).max(64),
  source: z.enum(['mic', 'mixed']),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string().max(64_000),
});

const queueStatusChanged = z.object({
  pending: z.number().int().nonnegative(),
  uploading: z.number().int().nonnegative(),
  failedPermanent: z.number().int().nonnegative(),
});

const permissionStateChanged = z.object({
  mic: permissionGrant,
  audioCapture: permissionGrant,
  accessibility: permissionGrant,
  notifications: permissionGrant,
});

const micActivityEvent = z.object({
  kind: z.enum(['detected', 'notified', 'dismissed', 'accepted']),
  occurredAt: z.number().int().nonnegative(),
});

const meetingDetected = z.object({
  promptId: z.string().min(1).max(64),
  suggestedTitle: z.string().max(256).optional(),
});

const amplitudeSample = z.object({
  // Allow a hair of slack on the upper bound (saturation isn't a panic).
  value: z.number().min(0).max(1.001),
  audioClockMs: z.number().int().nonnegative(),
});

const transcriptionUiState = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }),
  z.object({ kind: z.literal('processing') }),
  z.object({ kind: z.literal('failed'), sessionId: z.string().min(1).max(64) }),
  z.object({
    kind: z.literal('dictation_limit_reached'),
    sessionId: z.string().min(1).max(64),
  }),
]);

const navigateTab = z.object({
  tab: z.enum(['recording', 'dictations', 'meetings', 'settings']),
});

// HotkeyChanged: `primary` is the structured Hotkey or null. The strict
// shape is owned by HotkeyTypes; we just validate it's an object/null here.
const hotkeyChanged = z.object({
  primary: z
    .object({
      modifiers: z.array(z.string()).max(8),
      key: z.object({ code: z.string().max(64), display: z.string().max(64) }).nullable(),
    })
    .nullable(),
});

const hotkeyCaptureKey = z.object({
  kind: z.enum(['down', 'up']),
  code: z.string().min(1).max(32),
});

const inputDeviceInfo = z.object({
  id: z.string().min(1).max(256),
  name: z.string().max(256),
  isDefault: z.boolean(),
  kind: z.enum(['built_in', 'bluetooth', 'usb', 'other']),
});

const recordingListInputDevicesOutput = z.object({
  devices: z.array(inputDeviceInfo).max(64),
});

const summaryStatus = z.enum(['pending', 'completed', 'failed']);

const summaryStateChanged = z.object({
  sessionId: z.string().min(1).max(64),
  status: summaryStatus,
  summaryId: z.string().min(1).max(128).optional(),
});

const sessionRetrySummaryInput = z.object({
  sessionId: z.string().min(1).max(64),
});

const sessionOpenSummaryInput = z.object({
  sessionId: z.string().min(1).max(64),
});

const micDeviceLost = z.object({
  sessionId: z.string().min(1).max(64),
  mode: z.enum(['dictation', 'meeting']),
  lastDeviceLabel: z.string().max(256).nullable(),
  reason: z.string().max(128),
  devices: z.array(inputDeviceInfo).max(64),
});

const recordingResumeFromDeviceLossInput = z.object({
  sessionId: z.string().min(1).max(64),
  deviceId: z.string().max(256).nullable(),
});

// ─── Auth ────────────────────────────────────────────────────────────────────

const authUserView = z.object({
  // userIds from Firebase + transformed_sub can be longer than session ids;
  // cap at 256 to defend against pathological values without blocking the
  // realistic 30-50 char range.
  id: z.string().min(1).max(256),
  email: z.string().min(3).max(320),
  name: z.string().max(256).nullable(),
  // URL bound is generous; Google profile photo URLs include query params.
  photoUrl: z.string().max(2048).nullable(),
});

const authStateChanged = z.object({
  isAuthenticated: z.boolean(),
  user: authUserView.nullable(),
  // Names like FIREBASE_WEB_API_KEY — small bounded set.
  configMissing: z.array(z.string().min(1).max(64)).max(32).nullable(),
});

const authSignInOutput = z.object({
  ok: z.boolean(),
  error: z.enum(['cancelled', 'config_missing', 'network', 'unknown']).optional(),
  // Never includes tokens — cap matches the 4 KB secret cap elsewhere.
  message: z.string().max(4096).optional(),
});

// Main refuses sign-out while a recording is in flight; the renderer's
// AccountCard reads `error: 'recording_active'` and pops an in-app modal.
const authSignOutOutput = z.object({
  ok: z.boolean(),
  error: z.literal('recording_active').optional(),
});

const authListUsersOutput = z.object({
  users: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        email: z.string().min(3).max(320),
        name: z.string().max(256).nullable(),
        photoUrl: z.string().max(2048).nullable(),
        lastSignedInAt: z.number().int().nonnegative(),
        hasRefreshToken: z.boolean(),
      }),
    )
    .max(64),
});

const storageImportLegacyOutput = z.object({
  imported: z.boolean(),
  sessionsImported: z.number().int().nonnegative(),
});

const wizardGetStatusOutput = z.object({
  onboardingCompletedAt: z.number().int().nonnegative().nullable(),
});

/** Map of push channel → payload schema. Used by `bridge.main.broadcast()`. */
export const PushSchemas = {
  [PUSH.RECORDING_STATE]: recordingStateChanged,
  [PUSH.TRANSCRIPT_SEGMENT]: transcriptSegmentAppended,
  [PUSH.QUEUE_STATUS]: queueStatusChanged,
  [PUSH.PERMISSION_STATE]: permissionStateChanged,
  [PUSH.MIC_ACTIVITY]: micActivityEvent,
  [PUSH.MEETING_DETECTED]: meetingDetected,
  [PUSH.AMPLITUDE_SAMPLE]: amplitudeSample,
  [PUSH.TRANSCRIPTION_UI_STATE]: transcriptionUiState,
  [PUSH.NAVIGATE_TAB]: navigateTab,
  [PUSH.HOTKEY_CHANGED]: hotkeyChanged,
  [PUSH.HOTKEY_CAPTURE_KEY]: hotkeyCaptureKey,
  [PUSH.MIC_DEVICE_LOST]: micDeviceLost,
  [PUSH.AUTH_STATE_CHANGED]: authStateChanged,
  [PUSH.SUMMARY_STATE_CHANGED]: summaryStateChanged,
  [PUSH.HUD_EDGE_ANCHOR]: z.object({
    x: z.enum(['left', 'right', 'center']),
    y: z.enum(['top', 'bottom', 'center']),
  }),
  [PUSH.MIC_PERMISSION_REQUIRED]: z.object({
    mode: z.enum(['dictation', 'meeting']),
  }),
} as const;

// ─── REQUEST schemas (input + output per channel) ────────────────────────────

const startMeetingInput = z.object({ title: z.string().max(256).optional() });
const startMeetingOutput = z.object({ sessionId: z.string().min(1).max(64) });
const stopMeetingInput = z.object({ sessionId: z.string().min(1).max(64) });

const permissionKind = z.enum(['mic', 'audioCapture', 'accessibility', 'notifications']);
const permissionResult = z.object({ granted: z.boolean() });
const permissionReadInput = z.object({ kind: permissionKind });
const permissionReadOutput = z.object({
  grant: z.enum(['granted', 'denied', 'not_determined', 'unavailable']),
});
const openSystemSettingsInput = z.object({ kind: permissionKind });

const settingsPayload = z
  .object({ _version: z.number().int().positive() })
  // Permissive about other fields here; SettingsStore enforces the strict shape
  // when it parses the body. Schema versioning is the gate.
  .passthrough();

const sessionListItem = z.object({
  id: z.string().min(1).max(64),
  mode: z.enum(['dictation', 'meeting']),
  status: z.enum(['active', 'ended', 'paused_by_sleep', 'paused_by_device_loss']),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().nullable(),
  title: z.string().max(256).nullable(),
  failedCount: z.number().int().nonnegative(),
  /** Captured-audio duration in ms (max(chunks.end_ms) for this session). Null
   *  if the session has no chunks yet. Used by the UI as the displayed
   *  recording duration so device-loss pause gaps don't inflate it. */
  audioDurationMs: z.number().int().nonnegative().nullable(),
  summaryStatus: summaryStatus.nullable(),
  summaryId: z.string().max(128).nullable(),
  hasText: z.boolean(),
});

const sessionListInput = z.object({
  limit: z.number().int().positive().max(1_000).optional(),
});
const sessionListOutput = z.object({
  sessions: z.array(sessionListItem).max(1_000),
});

const sessionGetInput = z.object({ sessionId: z.string().min(1).max(64) });
const sessionGetOutput = sessionListItem.extend({
  transcripts: z.array(
    z.object({
      chunkId: z.string().min(1).max(64),
      startMs: z.number().int().nonnegative(),
      endMs: z.number().int().nonnegative(),
      overlapPrefixMs: z.number().int().nonnegative(),
      text: z.string().max(64_000),
      // Wall-clock epoch ms captured before /choose POST. Meeting transcript
      // view renders HH:MM from this. Null for pre-migration rows and
      // VAD-skipped chunks; the renderer falls back to relative MM:SS.
      clockTimeMs: z.number().int().nonnegative().nullable(),
    }),
  ),
});

const sessionDeleteInput = z.object({ sessionId: z.string().min(1).max(64) });
const sessionUpdateTitleInput = z.object({
  sessionId: z.string().min(1).max(64),
  // null = clear (UI falls back to "Untitled <mode>"). Capped at 50 chars
  // so list rows stay compact and don't wrap; UI enforces the same via
  // <input maxLength={50}>.
  title: z.string().max(50).nullable(),
});

const dictationListInput = z.object({
  limit: z.number().int().positive().max(1_000).optional(),
});
const dictationListOutput = z.object({
  dictations: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        status: z.enum(['active', 'ended', 'paused_by_sleep', 'paused_by_device_loss']),
        startedAt: z.number().int().nonnegative(),
        endedAt: z.number().int().nonnegative().nullable(),
        failedCount: z.number().int().nonnegative(),
        audioDurationMs: z.number().int().nonnegative().nullable(),
        transcripts: z.array(
          z.object({
            chunkId: z.string().min(1).max(64),
            startMs: z.number().int().nonnegative(),
            endMs: z.number().int().nonnegative(),
            overlapPrefixMs: z.number().int().nonnegative(),
            text: z.string().max(64_000),
            // Kept in sync with sessionGetOutput's transcripts schema —
            // dictation UI doesn't read this today but the field needs
            // to pass through the IPC bridge for parity with SESSION_GET.
            clockTimeMs: z.number().int().nonnegative().nullable(),
          }),
        ),
      }),
    )
    .max(1_000),
});
const sessionRetryFailedInput = z.object({ sessionId: z.string().min(1).max(64) });
const sessionRetryFailedOutput = z.object({
  retried: z.number().int().nonnegative(),
});

const diagnosticBundleOutput = z.object({ path: z.string().min(1).max(4096) });

const micActivityEventRow = z.object({
  id: z.number().int().nonnegative(),
  occurredAt: z.number().int().nonnegative(),
  state: z.enum(['started', 'stopped', 'notified', 'dismissed', 'accepted', 'suppressed']),
  sourcePid: z.number().int().nullable(),
  sourceBundle: z.string().max(256).nullable(),
  meta: z.string().max(4096).nullable(),
});
const meetingDetectionStatusOutput = z.object({
  monitorAvailable: z.boolean(),
  monitorLoadError: z.string().max(2048).nullable(),
  serviceStarted: z.boolean(),
  serviceStartedAt: z.number().int().nonnegative().nullable(),
  recentEvents: z.array(micActivityEventRow).max(200),
});

const hudDragMoveByInput = z.object({
  // Cap the per-message delta so a runaway renderer can't fling the window
  // off-screen in one frame.
  dx: z.number().min(-10_000).max(10_000),
  dy: z.number().min(-10_000).max(10_000),
});

const hudSetMouseIgnoreInput = z.object({ ignore: z.boolean() });

const hudSetVisualStateInput = z.object({
  visual: z.enum([
    'idle',
    'hoverIdle',
    'busy',
    'recording',
    'processing',
    'failed',
    'dictationLimit',
    'disconnected',
    'micPermission',
  ]),
});

/** Map of request channel → { input, output } schemas. */
export const RequestSchemas = {
  [REQUEST.REC_START_DICTATION]: { input: empty, output: empty },
  [REQUEST.REC_STOP_DICTATION]: { input: empty, output: empty },
  [REQUEST.REC_START_MEETING]: { input: startMeetingInput, output: startMeetingOutput },
  [REQUEST.REC_STOP_MEETING]: { input: stopMeetingInput, output: empty },
  [REQUEST.PERMISSIONS_REQUEST_MIC]: { input: empty, output: permissionResult },
  [REQUEST.PERMISSIONS_REQUEST_AUDIO_CAP]: { input: empty, output: permissionResult },
  [REQUEST.PERMISSIONS_REQUEST_ACCESSIBILITY]: { input: empty, output: permissionResult },
  [REQUEST.PERMISSIONS_REQUEST_NOTIFICATIONS]: { input: empty, output: permissionResult },
  [REQUEST.PERMISSIONS_READ]: { input: permissionReadInput, output: permissionReadOutput },
  [REQUEST.PERMISSIONS_OPEN_SYSTEM_SETTINGS]: { input: openSystemSettingsInput, output: empty },
  [REQUEST.SETTINGS_GET]: { input: empty, output: settingsPayload },
  [REQUEST.SETTINGS_SET]: { input: settingsPayload, output: empty },
  [REQUEST.SESSION_LIST]: { input: sessionListInput, output: sessionListOutput },
  [REQUEST.SESSION_GET]: { input: sessionGetInput, output: sessionGetOutput },
  [REQUEST.SESSION_DELETE]: { input: sessionDeleteInput, output: empty },
  [REQUEST.SESSION_UPDATE_TITLE]: { input: sessionUpdateTitleInput, output: empty },
  [REQUEST.DICTATION_LIST]: { input: dictationListInput, output: dictationListOutput },
  [REQUEST.DIAGNOSTIC_EXPORT_BUNDLE]: { input: empty, output: diagnosticBundleOutput },
  [REQUEST.DATA_DELETE_EVERYTHING]: { input: empty, output: empty },
  [REQUEST.HUD_BEGIN_DRAG]: { input: empty, output: empty },
  [REQUEST.HUD_DRAG_MOVE_BY]: { input: hudDragMoveByInput, output: empty },
  [REQUEST.HUD_END_DRAG]: { input: empty, output: empty },
  [REQUEST.SESSION_RETRY_FAILED]: {
    input: sessionRetryFailedInput,
    output: sessionRetryFailedOutput,
  },
  [REQUEST.MAIN_SHOW_SESSIONS_TAB]: { input: empty, output: empty },
  [REQUEST.MAIN_SHOW_HOME]: { input: empty, output: empty },
  [REQUEST.DIAGNOSTIC_MEETING_DETECTION_STATUS]: {
    input: empty,
    output: meetingDetectionStatusOutput,
  },
  [REQUEST.HOTKEY_CAPTURE_BEGIN]: { input: empty, output: empty },
  [REQUEST.HOTKEY_CAPTURE_END]: { input: empty, output: empty },
  [REQUEST.RECORDING_LIST_INPUT_DEVICES]: {
    input: empty,
    output: recordingListInputDevicesOutput,
  },
  [REQUEST.HUD_SET_MOUSE_IGNORE]: { input: hudSetMouseIgnoreInput, output: empty },
  [REQUEST.HUD_SET_VISUAL_STATE]: { input: hudSetVisualStateInput, output: empty },
  [REQUEST.REC_RESUME_FROM_DEVICE_LOSS]: { input: recordingResumeFromDeviceLossInput, output: empty },
  [REQUEST.AUTH_GET_STATE]: { input: empty, output: authStateChanged },
  [REQUEST.AUTH_SIGN_IN]: { input: empty, output: authSignInOutput },
  [REQUEST.AUTH_SIGN_OUT]: { input: empty, output: authSignOutOutput },
  [REQUEST.AUTH_LIST_USERS]: { input: empty, output: authListUsersOutput },
  [REQUEST.AUTH_CANCEL_SIGN_IN]: { input: empty, output: empty },
  [REQUEST.STORAGE_IMPORT_LEGACY]: { input: empty, output: storageImportLegacyOutput },
  [REQUEST.WIZARD_GET_STATUS]: { input: empty, output: wizardGetStatusOutput },
  [REQUEST.WIZARD_COMPLETE]: { input: empty, output: empty },
  [REQUEST.SESSION_RETRY_SUMMARY]: { input: sessionRetrySummaryInput, output: empty },
  [REQUEST.SESSION_OPEN_SUMMARY]: { input: sessionOpenSummaryInput, output: empty },
  [REQUEST.REC_DICTATION_LIMIT_DISMISS]: { input: empty, output: empty },
} as const;

export type RequestChannelName = keyof typeof RequestSchemas;
export type PushChannelName = keyof typeof PushSchemas;

/** Thrown by `bridge.main` when an inbound payload fails its schema. */
export class IpcValidationError extends Error {
  constructor(public readonly channel: string, public readonly issues: unknown) {
    super(`IPC validation failed on channel ${channel}`);
    this.name = 'IpcValidationError';
  }
}
