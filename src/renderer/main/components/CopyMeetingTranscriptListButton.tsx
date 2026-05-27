/**
 * Copy a meeting's transcript from the SessionsList row — fetches the
 * transcript via `sessions.get` on click (the list IPC doesn't include
 * chunks, since pre-loading 50 sessions' worth would be wasteful).
 *
 * Visual + output format match SessionDetail's CopyMeetingTranscriptButton
 * exactly; the formatter is shared via `transcriptClipboard`.
 *
 * Disabled when the row's `hasText` is false (same gate the detail view
 * uses). Fetch failures surface as a small inline error.
 */

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { formatTranscriptForClipboard } from './transcriptClipboard';

export function CopyMeetingTranscriptListButton({
  sessionId,
  sessionStartedAt,
  hasText,
}: {
  sessionId: string;
  sessionStartedAt: number;
  hasText: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabled = !hasText || busy;

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled) return;
    setError(null);
    setBusy(true);
    try {
      const r = await window.electronAPI.sessions.get({ sessionId });
      const text = formatTranscriptForClipboard(r.transcripts, sessionStartedAt);
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        data-testid="session-row-copy-button"
        data-copied={copied ? 'true' : 'false'}
        onClick={handleCopy}
        disabled={disabled}
        className="inline-flex items-center gap-1 rounded-md border border-zinc-400 bg-black px-2 py-0.5 text-[11px] font-medium text-zinc-300 transition hover:border-zinc-300 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-zinc-400 disabled:hover:text-zinc-300"
        aria-label={copied ? 'Copied' : 'Copy transcript'}
        title={copied ? 'Copied' : 'Copy transcript'}
      >
        {copied ? (
          // On the dark row background emerald-400 has enough contrast,
          // unlike the white-pill variant which needs emerald-600.
          <Check className="h-3 w-3 text-emerald-400" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
      {error && <span className="text-[11px] text-red-400">{error}</span>}
    </div>
  );
}
