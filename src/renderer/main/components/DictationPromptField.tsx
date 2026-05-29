/**
 * DictationPromptField — the "Personalize your Dictation" editor.
 *
 * Shows the built-in default prompt (or the user's saved custom prompt) in a
 * fixed-height, scrollable textarea. Apply / Cancel appear only when the text
 * differs from what's saved. Clearing the field (or typing the default back)
 * and applying stores `null` (fallback to the default) and re-populates the
 * box with the default text, so it's never left blank.
 *
 * Unlike the rest of SettingsPage (which auto-saves on every change), edits
 * here live in local state and only persist on Apply — that's what the
 * Apply/Cancel affordance is for.
 */

import { useEffect, useState } from 'react';
import {
  DEFAULT_DICTATION_PROMPT,
  MAX_DICTATION_PROMPT_LENGTH,
} from '@core/asr/dictationPrompt';

interface Props {
  /** Saved custom prompt; `null` means "use the default". */
  readonly value: string | null;
  /** Persist the new value. `null` = clear (fall back to default). */
  readonly onApply: (next: string | null) => void;
}

export function DictationPromptField({ value, onApply }: Props) {
  // What the saved state renders as: the custom prompt, or the default when null.
  const effectiveSaved = value ?? DEFAULT_DICTATION_PROMPT;
  const [text, setText] = useState(effectiveSaved);

  // Re-sync when the persisted value changes (after Apply, or an external
  // reload). `value` is a primitive, so this only fires on a real change — it
  // won't clobber an in-progress edit when an unrelated setting updates.
  useEffect(() => {
    setText(value ?? DEFAULT_DICTATION_PROMPT);
  }, [value]);

  const dirty = text !== effectiveSaved;

  const apply = () => {
    const trimmed = text.trim();
    // Empty or exactly the default → store null (fallback) and repopulate the
    // box with the default so the user can keep tweaking from a known base.
    if (trimmed === '' || trimmed === DEFAULT_DICTATION_PROMPT.trim()) {
      onApply(null);
      setText(DEFAULT_DICTATION_PROMPT);
      return;
    }
    onApply(text);
  };

  const cancel = () => setText(effectiveSaved);

  return (
    <div className="space-y-2">
      <textarea
        data-testid="dictation-prompt-input"
        value={text}
        maxLength={MAX_DICTATION_PROMPT_LENGTH}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        aria-label="Dictation prompt"
        className="h-40 w-full resize-none overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs leading-relaxed text-zinc-100 focus:border-zinc-500 focus:outline-none"
      />
      <div className="flex items-center justify-between">
        <span className="text-xs tabular-nums text-zinc-500">
          {text.length} / {MAX_DICTATION_PROMPT_LENGTH}
        </span>
        {dirty && (
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="dictation-prompt-cancel"
              onClick={cancel}
              className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="dictation-prompt-apply"
              onClick={apply}
              className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500"
            >
              Apply
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
