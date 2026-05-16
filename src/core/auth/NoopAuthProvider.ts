/**
 * NoopAuthProvider — the "no account, always allowed" impl.
 *
 * Architecture: §9.6 — ships today. Settings UI hides any "Account" / "Sign in"
 * affordance when the provider is Noop (see composition wiring + §16.2).
 *
 * `isAuthenticated()` returns true so flows that gate on auth don't accidentally
 * block local-only users. The label is null so we don't render an empty header.
 */

import type { AuthState, AuthUnsubscribe, IAuthProvider } from './IAuthProvider';

const STATE: AuthState = { userId: null, label: null };

export class NoopAuthProvider implements IAuthProvider {
  /** Always true; no auth gate for the local-only flow. */
  isAuthenticated(): boolean {
    return true;
  }

  /** Returns a frozen "signed-out-but-allowed" state. */
  getState(): AuthState {
    return STATE;
  }

  /** No state ever changes; the callback is never invoked. */
  onAuthChange(_cb: (state: AuthState) => void): AuthUnsubscribe {
    // The cast is necessary because TS sees this as an unused parameter.
    void _cb;
    return () => {};
  }
}
