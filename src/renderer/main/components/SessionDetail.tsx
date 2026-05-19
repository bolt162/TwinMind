/**
 * SessionDetail — transcript view for one session.
 *
 * Fetches via session.get (IPC). Renders chunks in chronological order with
 * a small timestamp gutter. Chunks without a transcript (still uploading or
 * VAD-skipped) are absent — we don't show empty placeholders.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, Loader2, Mic, Radio } from 'lucide-react';
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
      {data && <TranscriptList items={data.transcripts} />}
    </div>
  );
}

function SessionHeader({ data }: { data: NonNullable<ReturnType<typeof useSession>['data']> }) {
  const Icon = data.mode === 'meeting' ? Radio : Mic;
  const started = new Date(data.startedAt);
  const durationSec = data.endedAt
    ? Math.max(0, Math.round((data.endedAt - data.startedAt) / 1000))
    : null;
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-zinc-800 text-zinc-300">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <EditableTitle sessionId={data.id} initial={data.title} mode={data.mode} />
          <div className="text-xs text-zinc-500">
            {started.toLocaleString()} · {data.mode}
            {durationSec !== null && ` · ${formatDuration(durationSec)}`}
            {data.status === 'active' && (
              <span className="ml-2 rounded-full bg-red-600/30 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
                live
              </span>
            )}
            {data.status === 'paused_by_sleep' && ' · paused by sleep'}
          </div>
        </div>
      </div>
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
        maxLength={50}
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
        className="block w-full truncate rounded text-left text-sm font-medium text-zinc-100 hover:bg-zinc-800/60"
      >
        {value ?? <span className="text-zinc-400">{`Untitled ${mode}`}</span>}
      </button>
      {error && <div className="text-xs text-red-400">Couldn't save: {error}</div>}
    </>
  );
}

function TranscriptList({
  items,
}: {
  items: ReadonlyArray<{
    chunkId: string;
    startMs: number;
    endMs: number;
    overlapPrefixMs: number;
    text: string;
  }>;
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
      {items.map((t, i) => {
        // Display the *new-content* range, hiding the 2 s overlap prepend so
        // adjacent chunks render as a clean 0:00–0:30 / 0:30–1:00 sequence.
        const displayStart = t.startMs + t.overlapPrefixMs;
        // Use the next chunk's display-start as this chunk's display-end so
        // rows always touch exactly. Each WAV's stored end_ms drifts a few
        // tens of ms from the architectural 32 s target (mixer frame
        // boundaries + close_chunk round-trip), which `Math.floor` in
        // formatTimestamp can magnify into a visible 1 s gap. Only the final
        // chunk falls back to its real end_ms — it has no successor and is
        // legitimately short (user stopped mid-window).
        const next = items[i + 1];
        const displayEnd = next ? next.startMs + next.overlapPrefixMs : t.endMs;
        return (
          <li key={t.chunkId} className="flex gap-3">
            <span className="shrink-0 font-mono text-xs text-zinc-500 tabular-nums">
              {formatTimestamp(displayStart)} – {formatTimestamp(displayEnd)}
            </span>
            <span className="text-sm text-zinc-100 whitespace-pre-wrap">{t.text}</span>
          </li>
        );
      })}
    </ol>
  );
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
