/**
 * Device-type identifier sent on backend API calls (transcribe + summary).
 *
 * The backend buckets desktop traffic by this string to distinguish macOS
 * from Windows from web/mobile clients. Confirmed values with the backend
 * team:
 *   - 'mac'     → macOS (current shipping target)
 *   - 'windows' → Windows (future target, code path stays ready)
 *   - 'desktop' → fallback for any other Node platform (linux, freebsd, …)
 *                 that the desktop app might end up running on. Keeps the
 *                 wire format predictable rather than emitting whatever
 *                 `process.platform` returned.
 *
 * Pure runtime check — no caching needed; `process.platform` is set once at
 * process start and never changes. Re-evaluating per call is microseconds.
 */
export function resolveDeviceType(): 'mac' | 'windows' | 'desktop' {
  switch (process.platform) {
    case 'darwin':
      return 'mac';
    case 'win32':
      return 'windows';
    default:
      return 'desktop';
  }
}
