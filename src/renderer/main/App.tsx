/**
 * App — main window root.
 *
 * Routes to Onboarding when `settings.onboardingCompletedAt` is null;
 * otherwise renders the tabbed Layout (Recording / Dictations / Meetings /
 * Settings).
 */

import { useEffect, useState } from 'react';
import { Layout, type Tab } from './components/Layout';
import { HomePage } from './components/HomePage';
import { SessionsList } from './components/SessionsList';
import { DictationsTiles } from './components/DictationsTiles';
import { SettingsPage } from './components/SettingsPage';
import { OnboardingFlow } from './onboarding/OnboardingFlow';
import { useSettings } from './hooks/useSettings';

export function App() {
  const { settings, save, loading } = useSettings();
  const [tab, setTab] = useState<Tab>('recording');

  // Listen for main → renderer tab-navigation pushes. Fired when the HUD's
  // "History" button or the failed-transcription notification is clicked.
  useEffect(() => {
    const unsub = window.electronAPI.on.navigateTab((e) => {
      setTab(e.tab);
    });
    return () => unsub();
  }, []);

  if (loading || !settings) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        Loading…
      </div>
    );
  }

  if (!settings.onboardingCompletedAt) {
    // Pass App's own settings+save into OnboardingFlow so the flag set on the
    // final step lands in this component's state and routes us out.
    return <OnboardingFlow settings={settings} save={save} />;
  }

  return (
    <Layout tab={tab} onTabChange={setTab}>
      {tab === 'recording' && <HomePage />}
      {tab === 'dictations' && <DictationsTiles />}
      {tab === 'meetings' && <SessionsList mode="meeting" />}
      {tab === 'settings' && <SettingsPage />}
    </Layout>
  );
}
