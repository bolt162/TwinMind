/**
 * Initial schema migration as a TS string export.
 *
 * Architecture: §10.2 (schema), §10.3 (FSM), §7.10 (sleep boundary), §11.7 (retention).
 *
 * Why an inline string rather than a `.sql` file: bundling for Electron's main
 * process + the utility process makes `fs.readFileSync(import.meta.url-relative)`
 * fragile across dev (vite-node, ESM), prod (esbuild bundle, CJS), and test
 * (vitest, ESM-flavored). An inline string is the same bytes in every environment.
 *
 * Never edit this string after a release; add a new `0002_*.ts` for any change.
 *
 * Note: PRAGMAs (journal_mode, foreign_keys, synchronous) are NOT applied here —
 * SQLite forbids `journal_mode` / `synchronous` inside a transaction, and
 * migrations run inside one. `prepareDatabase()` in Migrator.ts applies them
 * before this migration runs.
 */

export const SQL_V1_INITIAL = `
-- Sessions: one row per recording session (dictation or meeting).
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,                -- uuid v4
  mode            TEXT NOT NULL CHECK(mode IN ('dictation','meeting')),
  -- 'active'           : capture in progress.
  -- 'ended'            : capture finished normally.
  -- 'paused_by_sleep'  : OS sleep/suspend; resume window per §7.10.
  status          TEXT NOT NULL CHECK(status IN
    ('active','ended','paused_by_sleep')) DEFAULT 'active',
  started_at      INTEGER NOT NULL,                -- epoch ms
  ended_at        INTEGER,
  -- Why the session ended; surfaced to UI/telemetry. NULL while status='active'.
  -- 'user' | 'disk_full' | 'no_device' | 'sleep_timeout' | 'crash' | 'audio_process_lost'
  end_reason      TEXT,
  title           TEXT,
  device_label    TEXT,                            -- best-effort, e.g. "MacBook Pro Mic"
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  -- Forward-compat for TwinMind backend sync; both columns are NULL on local-only installs.
  synced_at       INTEGER,
  remote_id       TEXT
);

-- Chunks: unit of upload. Dictation has one (idx=0, source='mic'); meeting has
-- many (source='mixed' for the pre-mixed mic+system stream — see §7.5).
CREATE TABLE chunks (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  idx                 INTEGER NOT NULL,
  -- 'mic'  : dictation mode (single stream).
  -- 'mixed': meeting mode, mic+system already pre-mixed in audio-process.
  source              TEXT NOT NULL CHECK(source IN ('mic','mixed')),
  file_path           TEXT NOT NULL,
  start_ms            INTEGER NOT NULL,            -- offset from sessions.started_at
  end_ms              INTEGER NOT NULL,
  overlap_prefix_ms   INTEGER NOT NULL DEFAULT 0,  -- 2s in meeting mode (chunks N+1..)
  duration_ms         INTEGER NOT NULL,
  bytes               INTEGER NOT NULL,
  sha256              TEXT,
  -- State machine enforced in app code (see ChunkState.ts).
  state               TEXT NOT NULL CHECK(state IN
    ('captured','uploading','transcribed','completed','failed_retry','failed_permanent')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     INTEGER,                     -- epoch ms; NULL means "now"
  last_error_class    TEXT,
  last_error_msg      TEXT,
  -- Set to 1 when this chunk opened immediately after a device-change event (§7.7).
  device_boundary     INTEGER NOT NULL DEFAULT 0,
  -- Set to 1 when this chunk opened after a sleep/wake resume (§7.10).
  sleep_boundary      INTEGER NOT NULL DEFAULT 0,
  -- Set by the retention sweep when the audio file is removed but the row is kept
  -- (failed_permanent chunks aged past the retention horizon per §11.7).
  file_deleted_at     INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  -- (session_id, idx, source) uniquely identifies a chunk slot; prevents accidental
  -- double-insertion during retries or recovery.
  UNIQUE(session_id, idx, source)
);

-- Partial index for the upload-eligibility query — mirrors ELIGIBLE_FOR_UPLOAD in
-- ChunkState.ts. The predicate must match exactly; drift is tested in unit.
CREATE INDEX idx_chunks_eligible ON chunks(state, next_attempt_at)
  WHERE state IN ('captured','failed_retry');

-- Transcripts: one row per chunk that produced text. VAD-skipped chunks also
-- write a row here with text='' and provider='local_vad' (see §7.11) so the
-- "completed ⇒ transcripts row exists" invariant holds for every completed chunk.
CREATE TABLE transcripts (
  chunk_id        TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  text            TEXT NOT NULL,
  words_json      TEXT,                            -- JSON array of {word,startMs,endMs}
  provider        TEXT NOT NULL,                   -- e.g. 'groq', 'twinmind', 'local_vad'
  model           TEXT,                            -- e.g. 'whisper-large-v3'
  language        TEXT,
  confidence      REAL,
  created_at      INTEGER NOT NULL,
  synced_at       INTEGER                          -- forward-compat for backend sync
);

-- Mic-activity events: §8 transparency log. Lives forever; small table.
CREATE TABLE mic_activity_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at     INTEGER NOT NULL,
  state           TEXT NOT NULL CHECK(state IN
    ('started','stopped','notified','dismissed','accepted','suppressed')),
  source_pid      INTEGER,                         -- nullable; 14+ enhancement
  source_bundle   TEXT,                            -- nullable
  meta            TEXT                             -- JSON; free-form
);

-- Generic key-value store for things that don't deserve their own table:
-- encrypted Groq key (Electron safeStorage payload), \`onboarding_completed_at\`, etc.
CREATE TABLE kv (
  k               TEXT PRIMARY KEY,
  v               TEXT NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- The applied-migrations log. The Migrations runner inserts a row after each
-- successful apply. PRAGMA user_version is the authoritative version number;
-- this table is kept for diagnostics + audit.
CREATE TABLE schema_migrations (
  version         INTEGER PRIMARY KEY,
  applied_at      INTEGER NOT NULL
);
`;
