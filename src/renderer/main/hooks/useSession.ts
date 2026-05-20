/**
 * useSession — fetches a single session's transcript via IPC.
 *
 * Auto-refreshes when the recording state changes so a live session's
 * transcript trickles in as new chunks land. The reload is debounced to one
 * call per state-change event; in steady state (idle) we don't poll.
 */

import { useCallback, useEffect, useState } from 'react';

export interface SessionTranscriptItem {
  chunkId: string;
  startMs: number;
  endMs: number;
  overlapPrefixMs: number;
  text: string;
}

export interface SessionDetailData {
  id: string;
  mode: 'dictation' | 'meeting';
  status: 'active' | 'ended' | 'paused_by_sleep' | 'paused_by_device_loss';
  startedAt: number;
  endedAt: number | null;
  title: string | null;
  audioDurationMs: number | null;
  /** Per-meeting summary lifecycle; null for dictation / not attempted. */
  summaryStatus: 'pending' | 'completed' | 'failed' | null;
  /** Backend-assigned summary id once `summaryStatus === 'completed'`. */
  summaryId: string | null;
  transcripts: SessionTranscriptItem[];
}

export function useSession(sessionId: string) {
  const [data, setData] = useState<SessionDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await window.electronAPI.sessions.get({ sessionId });
      setData(r as unknown as SessionDetailData);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void reload();
    // Live updates: refresh when this session's chunks land, plus on
    // start/stop transitions.
    const unsubState = window.electronAPI.on.recordingStateChanged(() => {
      void reload();
    });
    const unsubSeg = window.electronAPI.on.transcriptSegmentAppended((e) => {
      if (e.sessionId === sessionId) void reload();
    });
    // Refresh on summary lifecycle transitions so the "View Summary" / "Generate
    // summary" button updates the moment the backend responds.
    const unsubSummary = window.electronAPI.on.summaryStateChanged((e) => {
      if (e.sessionId === sessionId) void reload();
    });
    return () => {
      unsubState();
      unsubSeg();
      unsubSummary();
    };
  }, [reload, sessionId]);

  return { data, error, loading, reload };
}
