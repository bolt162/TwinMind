/**
 * SessionDetail — transcript view for one session.
 *
 * Fetches via session.get (IPC). Renders chunks in chronological order with
 * a small timestamp gutter. Chunks without a transcript (still uploading or
 * VAD-skipped) are absent — we don't show empty placeholders.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ExternalLink, Loader2, Mic, Radio, Sparkles } from 'lucide-react';
import { useSession } from '../hooks/useSession';

interface Props {
  readonly sessionId: string;
  readonly onClose: () => void;
}

export function SessionDetail({ sessionId, onClose }: Props) {
  const { data, error, loading } = useSession(sessionId);

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onClose}
        className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> Back to sessions
      </button>

      {loading && !data && (
        <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading transcript…
        </div>
      )}

      {error && !data && (
        <div className="rounded-lg border border-red-900/60 bg-red-950/40 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {data && <SessionHeader data={data} />}
      {data && <TranscriptList items={data.transcripts} mode={data.mode} />}
    </div>
  );
}

function SessionHeader({ data }: { data: NonNullable<ReturnType<typeof useSession>['data']> }) {
  const Icon = data.mode === 'meeting' ? Radio : Mic;
  const started = new Date(data.startedAt);
  // Duration = captured audio time, not wall-clock-since-start. Device-loss
  // pauses and similar gaps don't get counted in the displayed total — the
  // chunk-table is the authoritative timeline.
  const durationSec =
    data.audioDurationMs !== null && data.audioDurationMs > 0
      ? Math.round(data.audioDurationMs / 1000)
      : null;
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-zinc-800 text-zinc-300">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <EditableTitle sessionId={data.id} initial={data.title} mode={data.mode} />
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
            <span>
              {started.toLocaleString()} · {data.mode}
              {durationSec !== null && ` · ${formatDuration(durationSec)}`}
            </span>
            {data.status === 'active' && (
              <span className="rounded-full bg-red-600/30 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
                live
              </span>
            )}
            {data.status === 'paused_by_sleep' && <span>· paused by sleep</span>}
            {data.status === 'paused_by_device_loss' && <span>· paused (mic disconnected)</span>}
            {data.mode === 'meeting' && data.status === 'ended' && (
              <SummaryButton sessionId={data.id} status={data.summaryStatus} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Per-meeting summary affordance shown next to the date/time row.
 *
 *   completed → "View Summary" — opens `${TWINMIND_APP_URL}/m/${sessionId}`
 *               externally via the host-validated MISC_OPEN_EXTERNAL_URL IPC.
 *   pending   → "Generating summary…" (disabled). The summary call is in
 *               flight; useSession will reload on the next push.
 *   failed    → "Generate summary" — clicking re-fires the request via
 *               SESSION_RETRY_SUMMARY. Same path the auto-trigger uses.
 *   null      → "Generate summary" — auto-trigger hasn't fired yet (e.g.
 *               chunks still landing). Clicking fires it manually.
 *
 * For a dictation session this component never mounts (the caller gates it).
 */
function SummaryButton({
  sessionId,
  status,
}: {
  sessionId: string;
  status: 'pending' | 'completed' | 'failed' | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    if (busy) return;
    setError(null);
    if (status === 'completed') {
      // Main builds the deep link from the configured TWINMIND_APP_URL +
      // session id, then opens it externally. The renderer never crafts a
      // URL the user could be tricked into following.
      try {
        await window.electronAPI.sessions.openSummary({ sessionId });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    setBusy(true);
    try {
      await window.electronAPI.sessions.retrySummary({ sessionId });
      // useSession refreshes on `summary_state_changed`; no manual reload.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const isCompleted = status === 'completed';
  const isPending = status === 'pending';
  const label = isPending
    ? 'Generating summary…'
    : isCompleted
      ? 'View Summary'
      : 'Generate summary';

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending || busy}
        className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition ${
          isCompleted
            ? 'border-emerald-800/60 bg-emerald-950/30 text-emerald-300 hover:border-emerald-700 hover:bg-emerald-900/40'
            : 'border-zinc-700 bg-zinc-800/50 text-zinc-200 hover:border-zinc-600 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50'
        }`}
      >
        {isCompleted ? <ExternalLink className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
        <span>{label}</span>
      </button>
      {error && <span className="text-[11px] text-red-400">{error}</span>}
    </div>
  );
}


/**
 * Click-to-edit title. Optimistic: the on-screen value flips immediately on
 * commit, then the IPC roundtrip runs in the background. On failure we
 * revert to the last-saved value and surface a small error caption.
 *
 * Empty / whitespace input collapses to null on the server, which the
 * display path renders back as "Untitled <mode>".
 */
function EditableTitle({
  sessionId,
  initial,
  mode,
}: {
  sessionId: string;
  initial: string | null;
  mode: 'dictation' | 'meeting';
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<string | null>(initial);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Keep local mirror in sync when the underlying session refetches and the
  // title changed on the server side (e.g., another window's edit).
  useEffect(() => {
    if (!editing) setValue(initial);
  }, [initial, editing]);

  const startEdit = () => {
    setDraft(value ?? '');
    setError(null);
    setEditing(true);
    // Defer focus until after the <input> renders.
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };

  const commit = async () => {
    const next = draft.trim() === '' ? null : draft.trim();
    setValue(next);
    setEditing(false);
    try {
      await window.electronAPI.sessions.updateTitle({ sessionId, title: next });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setValue(initial); // revert
    }
  };

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        placeholder={`Untitled ${mode}`}
        className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-sm font-medium text-zinc-100 outline-none focus:border-zinc-500"
      />
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={startEdit}
        title="Click to rename"
        className="block w-full line-clamp-3 rounded text-left text-sm font-medium text-zinc-100 hover:bg-zinc-800/60"
      >
        {value ?? <span className="text-zinc-400">{`Untitled ${mode}`}</span>}
      </button>
      {error && <div className="text-xs text-red-400">Couldn't save: {error}</div>}
    </>
  );
}

function TranscriptList({
  items,
  mode,
}: {
  items: ReadonlyArray<{
    chunkId: string;
    startMs: number;
    endMs: number;
    overlapPrefixMs: number;
    text: string;
    clockTimeMs: number | null;
  }>;
  mode: 'dictation' | 'meeting';
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
        No transcript yet. Chunks appear here as they're transcribed.
      </div>
    );
  }
  return (
    <ol className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      {items.map((t) => {
        // Display the *new-content* range, hiding the 2 s overlap prepend so
        // adjacent chunks render as a clean 0:00–0:30 / 0:30–1:00 sequence.
        // The audio-process pads chunks with silence at close so endMs lands
        // on the exact target millisecond — no further client-side workaround
        // needed for the floor-rounding flicker.
        const displayStart = t.startMs + t.overlapPrefixMs;
        // Meetings: show the wall-clock time at which the chunk was sent
        // to /choose (e.g. "14:02") instead of the relative range. Falls
        // back to relative when clockTimeMs is null (pre-migration rows,
        // VAD-skipped chunks, mock provider).
        const clockLabel =
          mode === 'meeting' && t.clockTimeMs !== null ? formatClockHHMM(t.clockTimeMs) : null;
        return (
          <li key={t.chunkId} className="flex gap-3">
            <span className="shrink-0 font-mono text-xs text-zinc-500 tabular-nums">
              {clockLabel ?? `${formatTimestamp(displayStart)} – ${formatTimestamp(t.endMs)}`}
            </span>
            <span className="text-sm text-zinc-100 whitespace-pre-wrap">{t.text}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Format epoch ms as 24-hour `HH:MM` in the user's locale (e.g. "14:02"). */
function formatClockHHMM(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m === 0 ? `${s}s` : `${m}m ${s}s`;
}
