/**
 * useDictations — fetches dictation sessions with their inline transcripts
 * for the tile view. Same refresh triggers as `useSessions` so a freshly
 * stopped dictation, an in-flight transcription, or a delete propagates.
 */

import { useCallback, useEffect, useState } from 'react';

export interface DictationTile {
  id: string;
  status: 'active' | 'ended' | 'paused_by_sleep';
  startedAt: number;
  endedAt: number | null;
  failedCount: number;
  transcripts: ReadonlyArray<{
    chunkId: string;
    startMs: number;
    endMs: number;
    text: string;
  }>;
}

export function useDictations(limit = 50) {
  const [dictations, setDictations] = useState<DictationTile[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(
    async (showSpinner: boolean) => {
      if (showSpinner) setLoading(true);
      const r = await window.electronAPI.dictations.list({ limit });
      setDictations(r.dictations.map((d) => ({ ...d })));
      if (showSpinner) setLoading(false);
    },
    [limit],
  );

  useEffect(() => {
    void reload(true);
    // Background refreshes: state change (new session ended), transcript
    // segment appended (an in-flight session got a new chunk transcribed),
    // and UI state (HUD failed/processing transitions).
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

  return { dictations, loading, reload, remove, retryFailed };
}
