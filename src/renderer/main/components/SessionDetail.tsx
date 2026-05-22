/**
 * SessionDetail — transcript view for one session.
 *
 * Fetches via session.get (IPC). Renders chunks in chronological order with
 * a small timestamp gutter. Chunks without a transcript (still uploading or
 * VAD-skipped) are absent — we don't show empty placeholders.
 */

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, Copy, ExternalLink, Loader2, Mic, Radio, Sparkles } from 'lucide-react';
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
      {data && (
        <TranscriptList
          items={data.transcripts}
          mode={data.mode}
          sessionStartedAt={data.startedAt}
          sessionId={data.id}
          sessionStatus={data.status}
          summaryStatus={data.summaryStatus}
        />
      )}
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
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Per-meeting summary affordance. Lives in the transcript header alongside
 * the Copy button so the two actions share a visual row.
 *
 *   completed → "View Summary" — opens `${TWINMIND_APP_URL}/m/${sessionId}`
 *               externally via the host-validated MISC_OPEN_EXTERNAL_URL IPC.
 *               Always enabled (user can re-open the link even if the
 *               transcript was wiped client-side).
 *   pending   → "Generating summary…" (disabled). The summary call is in
 *               flight; useSession will reload on the next push.
 *   failed    → "Generate summary" — clicking re-fires the request via
 *               SESSION_RETRY_SUMMARY. Same path the auto-trigger uses.
 *   null      → "Generate summary" — auto-trigger hasn't fired yet (e.g.
 *               chunks still landing). Clicking fires it manually.
 *
 * `hasText` disables Generate — same gate as the Copy button — because
 * the backend rejects empty-transcript summary requests with a 500.
 *
 * For a dictation session this component never mounts (the caller gates it).
 */
function SummaryButton({
  sessionId,
  status,
  hasText,
}: {
  sessionId: string;
  status: 'pending' | 'completed' | 'failed' | null;
  hasText: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCompleted = status === 'completed';
  const isPending = status === 'pending';
  // Generate requires transcript text; View has no such requirement.
  const disabled = isPending || busy || (!isCompleted && !hasText);

  const handleClick = async () => {
    if (disabled) return;
    setError(null);
    if (isCompleted) {
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
        disabled={disabled}
        className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800/50 px-2 py-0.5 text-[11px] text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-zinc-800/50"
        aria-label={label}
        title={label}
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
  sessionStartedAt,
  sessionId,
  sessionStatus,
  summaryStatus,
}: {
  items: ReadonlyArray<{
    chunkId: string;
    startMs: number;
    endMs: number;
    overlapPrefixMs: number;
    text: string;
  }>;
  mode: 'dictation' | 'meeting';
  sessionStartedAt: number;
  sessionId: string;
  sessionStatus: 'active' | 'ended' | 'paused_by_sleep' | 'paused_by_device_loss';
  summaryStatus: 'pending' | 'completed' | 'failed' | null;
}) {
  // Single source of truth for "is there any transcript text?" — drives the
  // Copy button's disabled state AND the Generate-summary disabled state.
  const hasText = items.some((t) => t.text.trim().length > 0);
  // Show the summary button only for ended meetings (matches the previous
  // SessionHeader gate). Active / paused meetings hide it because the
  // summary call requires a final transcript.
  const showSummary = mode === 'meeting' && sessionStatus === 'ended';

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
        No transcript yet. Chunks appear here as they're transcribed.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      {mode === 'meeting' && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Transcript
          </span>
          <div className="flex items-center gap-2">
            <CopyMeetingTranscriptButton
              items={items}
              sessionStartedAt={sessionStartedAt}
              hasText={hasText}
            />
            {showSummary && (
              <SummaryButton
                sessionId={sessionId}
                status={summaryStatus}
                hasText={hasText}
              />
            )}
          </div>
        </div>
      )}
      <ol className="space-y-2">
        {items.map((t) => {
          // Display the *new-content* start, hiding the 2 s overlap prepend so
          // adjacent chunks render contiguously (0:00→0:30→1:00 …). For
          // meetings we render the wall-clock equivalent — derived from
          // `session.started_at + chunk.start_ms + overlap` so EVERY chunk
          // gets a consistent HH:MM regardless of when it was transcribed
          // (pre-migration row, VAD-skipped, normal — all the same). For
          // dictation we keep the relative MM:SS – MM:SS range.
          const newContentStartMs = t.startMs + t.overlapPrefixMs;
          const label =
            mode === 'meeting'
              ? formatClockHHMM(sessionStartedAt + newContentStartMs)
              : `${formatTimestamp(newContentStartMs)} – ${formatTimestamp(t.endMs)}`;
          return (
            <li key={t.chunkId} className="flex gap-3">
              <span className="shrink-0 font-mono text-xs text-zinc-500 tabular-nums">
                {label}
              </span>
              <span className="text-sm text-zinc-100 whitespace-pre-wrap">{t.text}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Copy the whole meeting transcript to the clipboard, formatted as
 * `[HH:MM] chunk-text\n\n[HH:MM] chunk-text…`. Uses the same HH:MM
 * derivation as the inline timestamps so copied times match what the
 * user sees on screen exactly. Empty / VAD-skipped chunks are filtered
 * out so the output isn't littered with `[HH:MM]` lines and no text.
 *
 * Visual: Copy icon → Check icon for 1.5 s after success, then back to
 * Copy. Disabled when no chunks have any text. Matches the dictation
 * tile's copy affordance for visual consistency.
 */
function CopyMeetingTranscriptButton({
  items,
  sessionStartedAt,
  hasText,
}: {
  items: ReadonlyArray<{
    startMs: number;
    overlapPrefixMs: number;
    text: string;
  }>;
  sessionStartedAt: number;
  hasText: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const text = items
    .filter((t) => t.text.trim().length > 0)
    .map((t) => {
      const hhmm = formatClockHHMM(sessionStartedAt + t.startMs + t.overlapPrefixMs);
      return `[${hhmm}] ${t.text.trim()}`;
    })
    .join('\n\n');

  const handleCopy = async () => {
    if (!hasText) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      // Brief visual confirmation; reset after a beat so the user can copy
      // again without reloading.
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard write blocked — surface nothing; the user will notice the
         absence of the check icon. */
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={!hasText}
      className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800/50 px-2 py-0.5 text-[11px] text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-zinc-800/50"
      aria-label={copied ? 'Copied' : 'Copy transcript'}
      title={copied ? 'Copied' : 'Copy transcript'}
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-400" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
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
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  // Meetings can run for hours; once we cross the hour mark switch from
  // the friendly "5m 30s" to H:MM:SS so a 1.5-hour meeting reads as
  // "1:30:00" instead of "90m 0s".
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return m === 0 ? `${s}s` : `${m}m ${s}s`;
}
