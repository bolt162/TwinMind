/**
 * SessionsList — recent recordings filtered by `mode`, with title and time.
 *
 * Mounted twice (once per `Dictations` / `Meetings` tab). Filters the shared
 * list client-side because the list is small (capped at 50). Clicking a row
 * opens the SessionDetail view (transcript). Trash button on hover deletes
 * (with a soft confirm so we don't nuke by accident).
 */

import { useState } from 'react';
import { Trash2, Mic, Radio, RotateCw } from 'lucide-react';
import { useSessions, type SessionListItem } from '../hooks/useSessions';
import { SessionDetail } from './SessionDetail';
import { cn } from './cn';

interface SessionsListProps {
  readonly mode: 'dictation' | 'meeting';
}

export function SessionsList({ mode }: SessionsListProps) {
  const { sessions, loading, reload, remove, retryFailed } = useSessions();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (selectedId) {
    // Reload on Back so any title edit (or future per-session mutation) made
    // inside the detail view reflects in the row. The optimistic flip inside
    // SessionDetail keeps the in-view text correct; this is just so the list
    // catches up too.
    return (
      <SessionDetail
        sessionId={selectedId}
        onClose={() => {
          setSelectedId(null);
          void reload(false);
        }}
      />
    );
  }

  const filtered = sessions.filter((s) => s.mode === mode);
  const modeLabel = mode === 'dictation' ? 'dictations' : 'meetings';

  // Only show the "Loading…" placeholder on cold-load (sessions empty AND
  // mid-fetch). Background refreshes leave the existing list visible so the
  // UI doesn't blank-then-snap-back on every push.
  if (loading && sessions.length === 0) {
    return <div className="text-sm text-zinc-500">Loading {modeLabel}…</div>;
  }
  if (filtered.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 text-center text-sm text-zinc-400">
        No {modeLabel} yet. Start one from the Recording tab.
      </div>
    );
  }

  return (
    <ul className="space-y-1.5">
      {filtered.map((s) => (
        <SessionRow
          key={s.id}
          session={s}
          onOpen={() => setSelectedId(s.id)}
          onDelete={() => remove(s.id)}
          onRetry={() => retryFailed(s.id)}
        />
      ))}
    </ul>
  );
}

function SessionRow({
  session,
  onOpen,
  onDelete,
  onRetry,
}: {
  session: SessionListItem;
  onOpen: () => void;
  onDelete: () => void;
  onRetry: () => Promise<void>;
}) {
  const Icon = session.mode === 'meeting' ? Radio : Mic;
  const startedAt = new Date(session.startedAt);
  const isLive = session.status === 'active';
  const hasFailures = session.failedCount > 0;
  const [retrying, setRetrying] = useState(false);

  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      // Keep the spinner up briefly even after the IPC returns so the user
      // sees the affordance "took effect" before the row re-renders without
      // the Retry button (failedCount drops to 0 once chunks succeed).
      setTimeout(() => setRetrying(false), 400);
    }
  };

  return (
    <li
      className={cn(
        'group flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 transition-colors',
        'hover:border-zinc-700 hover:bg-zinc-900',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex flex-1 items-center gap-3 text-left"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-zinc-800 text-zinc-300">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-zinc-100">
              {session.title ?? `Untitled ${session.mode}`}
            </span>
            {isLive && (
              <span className="rounded-full bg-red-600/30 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
                live
              </span>
            )}
          </div>
          <div className="text-xs text-zinc-500">
            {startedAt.toLocaleString()} · {session.mode}
            {session.status === 'paused_by_sleep' && ' · paused by sleep'}
          </div>
        </div>
      </button>
      {hasFailures && (
        <button
          type="button"
          onClick={handleRetry}
          disabled={retrying}
          className={cn(
            'flex items-center gap-1 rounded-md border border-amber-800/70 bg-amber-900/30 px-2 py-1 text-xs font-medium text-amber-200',
            'hover:bg-amber-900/50 disabled:opacity-60',
          )}
          aria-label={`Retry ${session.failedCount} failed chunks`}
        >
          <RotateCw className={cn('h-3 w-3', retrying && 'animate-spin')} />
          Retry
        </button>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (confirm(`Delete "${session.title ?? session.mode}"? Audio and transcripts are removed.`)) {
            onDelete();
          }
        }}
        className="rounded-md p-1.5 text-zinc-500 opacity-0 transition-opacity hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100"
        aria-label="Delete session"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </li>
  );
}
