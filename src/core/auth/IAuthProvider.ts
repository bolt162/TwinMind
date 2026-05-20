/**
 * IAuthProvider — identity only.
 *
 * Architecture: §9.6 (redesigned). This interface is consumed by the Settings
 * UI ("am I signed in?") and the future `SyncService`. It is **not** consumed
 * by `UploadQueue` — each `IAsrClient` impl owns its own credential strategy.
 * That keeps auth-refresh races inside the one client that cares about them.
 *
 * The Noop impl reports "authenticated" so UI flows that gate on auth (e.g.
 * "Sign in to TwinMind" cards) stay hidden until the OAuth provider is wired.
 */

export interface AuthState {
  /** Stable user id for telemetry tags. Null for the noop case. */
  readonly userId: string | null;
  /** Display name or email for Settings UI. Null for the noop case. */
  readonly label: string | null;
}

export type AuthUnsubscribe = () => void;

export interface IAuthProvider {
  /** Current state, synchronous read (e.g. for first render). */
  isAuthenticated(): boolean;

  /** Current state with details for UI display. */
  getState(): AuthState;

  /**
   * Subscribe to state transitions; the callback fires on every change. Return
   * value is the unsubscribe fn — call it on teardown to avoid leaks.
   */
  onAuthChange(cb: (state: AuthState) => void): AuthUnsubscribe;

  /**
   * Optional: start a sign-in flow. Undefined on providers that have no UI.
   * Return type is `unknown` so concrete providers can surface structured
   * results (e.g. TwinMindAuthProvider returns a SignInResult with error
   * classification) without the interface forcing every provider into the
   * same shape.
   */
  signIn?(): Promise<unknown>;

  /** Optional: sign out and clear the persisted token. */
  signOut?(): Promise<void>;
}
