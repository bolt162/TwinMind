/**
 * Lightweight Result<T, E> type for places where throwing is the wrong shape:
 *   - boundary code where the error needs to flow back over IPC/JSON
 *   - retry-aware code paths that classify errors before deciding to re-throw
 *
 * Most of the codebase still uses thrown exceptions for genuinely exceptional
 * cases. Result is for *expected* failure paths (network down, file missing,
 * ASR rate-limited) where the caller needs to branch on the error class.
 */
export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Wrap a success value. */
export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

/** Wrap a failure value. */
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Type-guard: narrow a `Result` to its `ok` branch. */
export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}

/** Type-guard: narrow a `Result` to its error branch. */
export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return !r.ok;
}
