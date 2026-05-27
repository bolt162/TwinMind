/**
 * Per-meeting summary affordance, shared by SessionDetail and SessionsList.
 *
 *   completed → "View Summary" — opens `${TWINMIND_APP_URL}/m/${sessionId}`
 *               externally via the host-validated MISC_OPEN_EXTERNAL_URL IPC.
 *               Always enabled (user can re-open the link even if the
 *               transcript was wiped client-side).
 *   pending   → "Syncing…" rendered as plain muted text (no button). The
 *               summary call is in flight; useSession / useSessions reload
 *               on the next push and swap this for the completed-state pill.
 *   failed    → "Generate summary" — clicking re-fires the request via
 *               SESSION_RETRY_SUMMARY. Same path the auto-trigger uses.
 *   null      → "Generate summary" — auto-trigger hasn't fired yet (e.g.
 *               chunks still landing). Clicking fires it manually.
 *
 * `hasText` disables Generate — same gate as the Copy button — because
 * the backend rejects empty-transcript summary requests with a 500.
 */

import { useState } from 'react';
import { ExternalLink, Sparkles } from 'lucide-react';

export function SummaryButton({
  sessionId,
  status,
  hasText,
  variant = 'prominent',
}: {
  sessionId: string;
  status: 'pending' | 'completed' | 'failed' | null;
  hasText: boolean;
  /**
   * Visual style for the completed-state "View Summary" button.
   *   prominent — solid white pill, black text (SessionDetail).
   *   outline   — transparent pill, white border + text (SessionsList row,
   *               where a solid white pill would dominate the row visually).
   * Non-completed states ("Generate summary", "Generating summary…") share
   * the muted dark style across both variants.
   */
  variant?: 'prominent' | 'outline';
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCompleted = status === 'completed';
  const isPending = status === 'pending';

  // Pending: no actionable affordance. Render plain muted text so the row
  // stays clickable (the parent <li> opens the detail view).
  if (isPending) {
    return <span className="text-[11px] text-zinc-400">Syncing…</span>;
  }

  // Generate requires transcript text; View has no such requirement.
  const disabled = busy || (!isCompleted && !hasText);

  const handleClick = async (e: React.MouseEvent) => {
    // Live inside a clickable list row — don't bubble into the row's open.
    e.stopPropagation();
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const label = isCompleted ? 'View Summary' : 'Generate summary';

  // Completed-state styling switches on `variant`: prominent (default) is
  // the solid white pill used in SessionDetail; outline is a transparent
  // pill with a white border + white text, used by the SessionsList row.
  // Non-completed states share the muted dark style across both variants
  // since they're secondary fallbacks.
  const completedClass =
    variant === 'outline'
      ? 'inline-flex items-center gap-1 rounded-md border border-zinc-400 bg-black px-2 py-0.5 text-[11px] font-medium text-zinc-300 transition hover:border-zinc-300 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-zinc-400 disabled:hover:text-zinc-300'
      : 'inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-black transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white';
  const secondaryClass =
    'inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800/50 px-2 py-0.5 text-[11px] text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-zinc-800/50';
  const buttonClass = isCompleted ? completedClass : secondaryClass;

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className={buttonClass}
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
