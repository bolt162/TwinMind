/**
 * App — main window root.
 *
 * Three render states, gated explicitly:
 *   1. signed-out          → SignInScreen
 *   2. signed-in + !wizard → OnboardingFlow (permissions only — sign-in is
 *                            outside the wizard, so signing out does NOT
 *                            re-trigger onboarding)
 *   3. signed-in + wizard  → Layout (Recording / Dictations / Meetings / Settings)
 *
 * Auth state is fetched once on mount, then refreshed via the
 * `auth_state_changed` push. Wizard status is fetched on mount and after
 * the WIZARD_COMPLETE IPC.
 */

import { useEffect, useState } from 'react';
import { Layout, type Tab } from './components/Layout';
import { HomePage } from './components/HomePage';
import { SessionsList } from './components/SessionsList';
import { DictationsTiles } from './components/DictationsTiles';
import { SettingsPage } from './components/SettingsPage';
import { OnboardingFlow } from './onboarding/OnboardingFlow';
import { SignInScreen } from './SignInScreen';
import { useSettings } from './hooks/useSettings';

interface AuthState {
  isAuthenticated: boolean;
  user: { id: string; email: string; name: string | null; photoUrl: string | null } | null;
  configMissing: readonly string[] | null;
}

export function App() {
  const [tab, setTab] = useState<Tab>('recording');
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [wizardDone, setWizardDone] = useState<boolean | null>(null);

  // Subscribe to auth + tab-navigation pushes once.
  useEffect(() => {
    const unsubNav = window.electronAPI.on.navigateTab((e) => setTab(e.tab));
    const unsubAuth = window.electronAPI.on.authStateChanged((s) => setAuth(s));
    void window.electronAPI.auth.getState().then((s) => setAuth(s));
    return () => {
      unsubNav();
      unsubAuth();
    };
  }, []);

  // Pull wizard status once authenticated.
  useEffect(() => {
    if (!auth?.isAuthenticated) return;
    void window.electronAPI.wizard
      .getStatus()
      .then((s) => setWizardDone(s.onboardingCompletedAt !== null));
  }, [auth?.isAuthenticated]);

  if (!auth) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        Loading…
      </div>
    );
  }

  if (!auth.isAuthenticated) {
    return <SignInScreen configMissing={auth.configMissing} />;
  }

  // Authenticated but wizard status not yet fetched.
  if (wizardDone === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        Loading…
      </div>
    );
  }

  if (!wizardDone) {
    return (
      <OnboardingFlow
        onComplete={async () => {
          await window.electronAPI.wizard.complete();
          setWizardDone(true);
        }}
      />
    );
  }

  return (
    <AuthedLayout tab={tab} onTabChange={setTab} />
  );
}

/** Settings hook only mounts once we're authed — main refuses SETTINGS_GET pre-auth. */
function AuthedLayout({ tab, onTabChange }: { tab: Tab; onTabChange: (t: Tab) => void }) {
  const { settings, loading } = useSettings();
  if (loading || !settings) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        Loading…
      </div>
    );
  }
  return (
    <Layout tab={tab} onTabChange={onTabChange}>
      {tab === 'recording' && <HomePage />}
      {tab === 'dictations' && <DictationsTiles />}
      {tab === 'meetings' && <SessionsList mode="meeting" />}
      {tab === 'settings' && <SettingsPage />}
    </Layout>
  );
}
