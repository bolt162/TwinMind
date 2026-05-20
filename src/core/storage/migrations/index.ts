/**
 * Registry of migrations applied to the database, in order.
 *
 * Migration SQL is inlined as TS string exports (`0001_initial.ts` etc.) so we
 * don't depend on file resolution at runtime — see the file's header comment
 * for the full rationale. To add a migration:
 *   1. Create `0002_my_change.ts` exporting `SQL_V2_*`.
 *   2. Append an entry to `MIGRATIONS` below.
 *   3. Never edit a released migration's SQL — write a new file instead.
 */

import type { Migration } from '../Migrator';
import { SQL_V1_INITIAL } from './0001_initial';
import { SQL_V2_PAUSED_BY_DEVICE_LOSS } from './0002_paused_by_device_loss';
import { SQL_V3_SESSION_SUMMARY } from './0003_session_summary';
import { SQL_V5_TRANSCRIPT_CLOCK_TIME } from './0005_transcript_clock_time';

// Version 4 was an aborted attempt at storing a backend-supplied wall-clock
// string; the backend never sent that field, so the migration was reverted
// in commit 85590eb. Version 5 replaces it with a client-captured epoch-ms
// approach. Skipping 4 instead of reusing the slot keeps dev databases that
// already applied the old 0004 from re-running an unrelated ALTER.
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial', sql: SQL_V1_INITIAL },
  { version: 2, name: 'paused_by_device_loss', sql: SQL_V2_PAUSED_BY_DEVICE_LOSS },
  { version: 3, name: 'session_summary', sql: SQL_V3_SESSION_SUMMARY },
  { version: 5, name: 'transcript_clock_time', sql: SQL_V5_TRANSCRIPT_CLOCK_TIME },
];
