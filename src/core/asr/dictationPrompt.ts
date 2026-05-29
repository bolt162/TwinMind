/**
 * Shared dictation-prompt constants.
 *
 * The default cleanup instruction lives here (not inside TwinMindAsrClient) so
 * both the main process (ASR fallback) and the renderer (the "Personalize your
 * Dictation" settings field — display + fallback) import the SAME source of
 * truth. This module is intentionally pure (no node/electron imports) so the
 * renderer can import it without pulling in `node:fs` et al.
 *
 * `DEFAULT_DICTATION_PROMPT` is sent in the `prompt` form field for every
 * dictation chunk UNLESS the user has set a non-empty custom prompt in
 * Settings. The backend uses it to post-process the raw transcript: strip
 * filler words, resolve self-corrections, add punctuation / casing / paragraph
 * breaks, light formatting — without changing meaning or the speaker's voice.
 * Kept verbatim so a quick search ("Transcribe the audio") lands exactly here.
 */

export const DEFAULT_DICTATION_PROMPT = `Transcribe the audio. If there are no spoken words, return an empty string.

Clean the transcript into natural ready-to-use text. Return only the final text.

Rules:
- Add punctuation, capitalization, spacing, grammar fixes, and paragraph breaks.
- Remove fillers, stutters, repeated words, and false starts, e.g. “um,” “uh,” “like,” “you know.”
- Preserve meaning, facts, tone, and style. Do not add new ideas.
- Apply corrections like “actually,” “I mean,” “no,” “wait,” “scratch that,” or “rather.”
- Convert spoken punctuation/formatting when intended: comma, period, question mark, exclamation point, new line, new paragraph, colon, dash, bullet point.
- Convert spoken emoji names to emoji: “fire emoji” → 🔥, “yawning emoji” → 🥱, “yuck/nauseated emoji” → 🤢, “heart emoji” → ❤️. If the whole dictation is only emoji names, return only emojis separated by spaces.
- If text has greeting + body + closing/signature, always format as:
Greeting,

Body.

Closing,
Name
- Treat “Hello/Hi/Dear + name/title” as a greeting. Treat “Sincerely/Best regards/Regards/Thanks/Thank you + name” as closing + signature.
- If text contains “first/second/third/fourth/next/then/finally,” always convert the items into a numbered list.
- Remove list intros like “There are some things I need to...” when list items are clear.
- For chat messages, keep them concise and conversational.`;

/**
 * Hard cap on a user-supplied custom dictation prompt. Enforced in the
 * settings UI (textarea maxLength + counter) and defensively clamped where the
 * prompt is consumed, so a hand-edited settings.json can't inflate every
 * dictation request. The built-in default is comfortably under this.
 */
export const MAX_DICTATION_PROMPT_LENGTH = 2000;
