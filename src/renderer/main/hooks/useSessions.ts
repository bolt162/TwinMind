/**
 * useSessions — fetches the recent-sessions list via IPC and refreshes on
 * recording-state changes (so a freshly stopped session appears immediately).
 */

import { useCallback, useEffect, useState } from 'react';

export interface SessionListItem {
  id: string;
  mode: 'dictation' | 'meeting';
  status: 'active' | 'ended' | 'paused_by_sleep' | 'paused_by_device_loss';
  startedAt: number;
  endedAt: number | null;
  title: string | null;
  /** Retryable failed_permanent chunk count; drives the row's Retry button. */
  failedCount: number;
  /** Captured audio total in ms (max chunk.end_ms); null when no chunks. */
  audioDurationMs: number | null;
}

export function useSessions(limit = 50) {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [loading, setLoading] = useState(true);

  /**
   * Fetch + commit. `showSpinner` is true only on the initial mount; all
   * IPC-driven background refreshes pass false so the SessionsList doesn't
   * blank to "Loading sessions…" between IPC roundtrips. React diffs the
   * rows in place — no remount, no visible flash.
   */
  const reload = useCallback(
    async (showSpinner: boolean) => {
      if (showSpinner) setLoading(true);
      const r = await window.electronAPI.sessions.list({ limit });
      setSessions(r.sessions.map((s) => ({ ...s })));
      if (showSpinner) setLoading(false);
    },
    [limit],
  );

  useEffect(() => {
    void reload(true);
    // Background refreshes: pass false so we just update the rows silently.
    const refresh = () => {
      void reload(false);
    };
    const unsubState = window.electronAPI.on.recordingStateChanged(refresh);
    const unsubSegment = window.electronAPI.on.transcriptSegmentAppended(refresh);
    const unsubUiState = window.electronAPI.on.transcriptionUiState(refresh);
    return () => {
      unsubState();
      unsubSegment();
      unsubUiState();
    };
  }, [reload]);

  const remove = useCallback(
    async (sessionId: string) => {
      await window.electronAPI.sessions.delete({ sessionId });
      await reload(false);
    },
    [reload],
  );

  const retryFailed = useCallback(
    async (sessionId: string) => {
      await window.electronAPI.sessions.retryFailed({ sessionId });
      await reload(false);
    },
    [reload],
  );

  return { sessions, loading, reload, remove, retryFailed };
}
