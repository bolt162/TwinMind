/**
 * useRecordingState — subscribes to `recording_state_changed` pushes.
 *
 * Returns the most recent state snapshot, or null if main hasn't broadcast
 * yet. Components read this to render the right "recording / idle / ..." UI.
 */

import { useEffect, useState } from 'react';

export interface RecordingSnapshot {
  state: 'idle' | 'starting' | 'recording' | 'stopping' | 'paused_by_sleep' | 'ended';
  mode: 'idle' | 'dictation' | 'meeting';
  sessionId: string | null;
  elapsedMs: number;
}

export function useRecordingState(): RecordingSnapshot | null {
  const [snap, setSnap] = useState<RecordingSnapshot | null>(null);
  useEffect(() => {
    const unsub = window.electronAPI.on.recordingStateChanged((e) => {
      setSnap({
        state: e.state,
        mode: e.mode,
        sessionId: e.sessionId ?? null,
        elapsedMs: e.elapsedMs ?? 0,
      });
    });
    return () => unsub();
  }, []);
  return snap;
}
