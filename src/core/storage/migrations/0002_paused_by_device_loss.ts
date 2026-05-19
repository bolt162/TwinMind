/**
 * Migration 0002 — add 'paused_by_device_loss' to sessions.status.
 *
 * Triggered when the user has pinned a specific input device and that
 * device disappears mid-recording (BT off, USB unplug). The session is
 * suspended (not ended) so the user can pick a different device from the
 * HUD's inline picker and `Resume` to continue recording. Same lifecycle
 * shape as 'paused_by_sleep'; the recovery sweep auto-ends paused
 * sessions older than the same threshold (§11.5).
 *
 * SQLite doesn't support ALTER on a CHECK constraint directly — we
 * rebuild the table via the standard "create new + copy + swap" dance.
 * Cheap; sessions are a small table.
 */
export const SQL_V2_PAUSED_BY_DEVICE_LOSS = `
PRAGMA foreign_keys = OFF;

CREATE TABLE sessions_new (
  id              TEXT PRIMARY KEY,
  mode            TEXT NOT NULL CHECK(mode IN ('dictation','meeting')),
  status          TEXT NOT NULL CHECK(status IN
    ('active','ended','paused_by_sleep','paused_by_device_loss')) DEFAULT 'active',
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  end_reason      TEXT,
  title           TEXT,
  device_label    TEXT,
  created_at      INTEGER NOT NULL,
  synced_at       INTEGER,
  remote_id       TEXT
);

INSERT INTO sessions_new (
  id, mode, status, started_at, ended_at, end_reason,
  title, device_label, created_at, synced_at, remote_id
)
SELECT
  id, mode, status, started_at, ended_at, end_reason,
  title, device_label, created_at, synced_at, remote_id
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

PRAGMA foreign_keys = ON;
`;
