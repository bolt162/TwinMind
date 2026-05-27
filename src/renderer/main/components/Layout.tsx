/**
 * Layout — top-level shell for the main window.
 *
 * Tab nav (Home / Dictations / Meetings / Settings) plus a content area.
 * Active tab is held in App.tsx state so the user's selection survives focus
 * loss.
 *
 * The Home tab's id is still `'recording'` for IPC stability — the
 * NAVIGATE_TAB push channel and `MAIN_SHOW_HOME` handler all reference that
 * string. Only the user-visible label and icon changed when the tab was
 * repurposed from a control panel into a landing page.
 */

import type { ReactNode } from 'react';
import { cn } from './cn';
import { ArrowUpRight, Home, Mic, Radio, Settings as SettingsIcon } from 'lucide-react';

export type Tab = 'recording' | 'dictations' | 'meetings' | 'settings';

interface LayoutProps {
  readonly tab: Tab;
  readonly onTabChange: (t: Tab) => void;
  readonly children: ReactNode;
}

const TABS: ReadonlyArray<{ id: Tab; label: string; icon: typeof Home }> = [
  { id: 'recording', label: 'Home', icon: Home },
  { id: 'dictations', label: 'Dictations', icon: Mic },
  { id: 'meetings', label: 'Meetings', icon: Radio },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

export function Layout({ tab, onTabChange, children }: LayoutProps) {
  return (
    <div data-testid="app-layout" className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-4 pt-3 pb-2">
        <div className="flex items-center justify-between">
          <h1 className="text-sm font-semibold tracking-tight text-zinc-200">TwinMind</h1>
          <button
            type="button"
            data-testid="view-web-button"
            onClick={() => {
              void window.electronAPI.main.openWebApp().catch(() => {});
            }}
            className="flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100"
            aria-label="Open TwinMind on the web"
          >
            View Web
            <ArrowUpRight className="h-3 w-3" />
          </button>
        </div>
        <nav className="mt-3 flex gap-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              data-testid={`tab-${id}`}
              data-active={tab === id ? 'true' : 'false'}
              onClick={() => onTabChange(id)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                tab === id
                  ? 'bg-zinc-800 text-zinc-50'
                  : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </nav>
      </header>
      <main className="flex-1 overflow-y-auto p-4">{children}</main>
    </div>
  );
}
