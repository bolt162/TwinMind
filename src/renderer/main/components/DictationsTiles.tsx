/**
 * DictationsTiles — grid view for the Dictations tab.
 *
 * Each dictation is a self-contained tile: started-at time, duration, inline
 * transcript text (all chunks concatenated), and the same action buttons the
 * meeting rows have (retry / open-folder / delete). No title, no drill-in —
 * everything is right there on the tile.
 *
 * Meetings keep the list+detail flow because their transcripts can be very
 * long; dictations are typically short, so the tile fits.
 */

import { useState } from 'react';
import { Trash2, RotateCw, Mic, Copy, Check } from 'lucide-react';
import { useDictations, type DictationTile } from '../hooks/useDictations';
import { cn } from './cn';

export function DictationsTiles() {
  const { dictations, loading, remove, retryFailed } = useDictations();

  // Cold-load placeholder. Subsequent refreshes leave the existing tiles up
  // (React diffs in place) so the grid doesn't flash.
  if (loading && dictations.length === 0) {
    return <div className="text-sm text-zinc-500">Loading dictations…</div>;
  }
  if (dictations.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 text-center text-sm text-zinc-400">
        No dictations yet. Hold the dictation hotkey to record one.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {dictations.map((d) => (
        <DictationCard
          key={d.id}
          dictation={d}
          onDelete={() => remove(d.id)}
          onRetry={() => retryFailed(d.id)}
        />
      ))}
    </div>
  );
}

function DictationCard({
  dictation,
  onDelete,
  onRetry,
}: {
  dictation: DictationTile;
  onDelete: () => void;
  onRetry: () => Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);
  const [copied, setCopied] = useState(false);
  const started = new Date(dictation.startedAt);
  const durationSec = dictation.endedAt
    ? Math.max(0, Math.round((dictation.endedAt - dictation.startedAt) / 1000))
    : null;
  const isLive = dictation.status === 'active';
  const hasFailures = dictation.failedCount > 0;
  const fullText = dictation.transcripts.map((t) => t.text).join(' ').trim();
  const hasText = fullText.length > 0;

  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!hasText) return;
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      // Brief visual confirmation; reset after a beat so the user can copy
      // again without reloading the page.
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard write blocked — surface nothing; the user will notice the
         absence of the check icon. */
    }
  };

  return (
    <article className="group flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 transition-colors hover:border-zinc-700 hover:bg-zinc-900">
      <header className="flex items-start gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-800 text-zinc-300">
          <Mic className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-zinc-300">
              {formatStartedAt(started)}
            </span>
            {isLive && (
              <span className="rounded-full bg-red-600/30 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
                live
              </span>
            )}
            {dictation.status === 'paused_by_sleep' && (
              <span className="text-[10px] text-amber-300">paused by sleep</span>
            )}
          </div>
          {durationSec !== null && (
            <div className="text-[11px] text-zinc-500">{formatDuration(durationSec)}</div>
          )}
        </div>
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {hasFailures && (
            <button
              type="button"
              onClick={handleRetry}
              disabled={retrying}
              className={cn(
                'flex items-center gap-1 rounded-md border border-amber-800/70 bg-amber-900/30 px-2 py-1 text-[10px] font-medium text-amber-200',
                'hover:bg-amber-900/50 disabled:opacity-60',
              )}
              aria-label={`Retry ${dictation.failedCount} failed chunks`}
            >
              <RotateCw className={cn('h-3 w-3', retrying && 'animate-spin')} />
              Retry
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            disabled={!hasText}
            className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-500"
            aria-label={copied ? 'Copied' : 'Copy transcript'}
            title={copied ? 'Copied' : 'Copy transcript'}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm('Delete this dictation? Audio and transcript are removed.')) {
                onDelete();
              }
            }}
            className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            aria-label="Delete dictation"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="text-sm text-zinc-100 whitespace-pre-wrap break-words">
        {fullText.length > 0 ? (
          fullText
        ) : isLive ? (
          <span className="text-zinc-500 italic">Listening…</span>
        ) : (
          <span className="text-zinc-500 italic">No transcript yet.</span>
        )}
      </div>
    </article>
  );
}

/** "Today 2:34 PM" / "Yesterday 9:12 AM" / "Mar 12, 2:34 PM" */
function formatStartedAt(d: Date): string {
  const now = new Date();
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (same(d, now)) return `Today ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (same(d, yesterday)) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}
