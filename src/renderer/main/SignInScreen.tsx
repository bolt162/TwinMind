/**
 * SignInScreen — gates the entire app when no user is signed in.
 *
 * Architecture: sign-in is OUTSIDE the onboarding wizard. Signing out
 * returns here, but does NOT rewind the wizard — permissions are
 * machine-scoped, so a user who has already finished onboarding doesn't
 * see those steps again on the next sign-in.
 *
 * UX:
 *   - Single "Sign in" button — Google's account chooser handles
 *     disambiguation, so we don't pin a hint email to the URL (avoids
 *     forcing a particular Google account and gives the user a clear way
 *     to switch). The local user directory (auth.listUsers) keeps tracking
 *     previous sign-ins for backend/identity bookkeeping, just no longer
 *     surfaced as "Continue as" chips here.
 *   - If the backend env is unconfigured, show the missing-var list.
 */

import { useState } from 'react';

interface SignInScreenProps {
  /** Names of env vars the backend needs but doesn't have. Null when config is fine. */
  readonly configMissing: readonly string[] | null;
}

export function SignInScreen({ configMissing }: SignInScreenProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configBroken = configMissing && configMissing.length > 0;

  const handleSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await window.electronAPI.auth.signIn();
      if (!r.ok) {
        if (r.error === 'cancelled') {
          setError('Sign-in cancelled. Try again when you’re ready.');
        } else if (r.error === 'config_missing') {
          setError('TwinMind backend is not configured. See the diagnostics below.');
        } else if (r.error === 'network') {
          setError('Could not reach the TwinMind backend. Check your connection.');
        } else {
          setError(r.message ?? 'Sign-in failed. Please try again.');
        }
      }
      // On success, main.ts broadcasts AUTH_STATE_CHANGED and App re-routes.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-8 text-zinc-100">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 shadow-2xl">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">
          Welcome to TwinMind
        </h1>
        <p className="mt-2 text-sm text-zinc-400">
          Sign in to start dictating and recording meetings. Your recordings stay private
          to your account — different sign-ins on this Mac never share data.
        </p>

        {configBroken ? (
          <div className="mt-6 rounded-lg border border-amber-900/40 bg-amber-950/30 p-4 text-xs text-amber-200">
            <div className="font-medium">Backend not configured.</div>
            <div className="mt-1 text-amber-300/80">Missing environment variables:</div>
            <ul className="mt-2 list-disc pl-5 font-mono text-amber-100">
              {configMissing!.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <button
          type="button"
          onClick={handleSignIn}
          disabled={busy || !!configBroken}
          className="mt-6 w-full rounded-lg bg-zinc-50 px-4 py-2.5 text-sm font-medium text-zinc-950 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          {busy ? 'Opening browser…' : 'Sign in'}
        </button>

        {busy ? (
          // The 120 s loopback timeout is generous on purpose (2FA + slow
          // typing should fit), but a user who got distracted shouldn't have
          // to wait the full window. Cancel aborts the loopback server and
          // lets signIn() resolve with `error: 'cancelled'`; the existing
          // finally clause then re-enables the form.
          <button
            type="button"
            onClick={() => {
              void window.electronAPI.auth.cancelSignIn().catch(() => {});
            }}
            className="mt-2 w-full rounded-lg border border-zinc-800 px-4 py-2 text-xs text-zinc-400 transition hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-200"
          >
            Cancel
          </button>
        ) : null}

        {error ? (
          <div className="mt-4 rounded-md border border-rose-900/40 bg-rose-950/30 p-3 text-xs text-rose-200">
            {error}
          </div>
        ) : null}

        <p className="mt-6 text-xs text-zinc-500">
          We use Google for sign-in only. You can sign out at any time from Settings.
        </p>
      </div>
    </div>
  );
}
