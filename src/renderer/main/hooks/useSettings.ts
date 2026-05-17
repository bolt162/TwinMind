/**
 * useSettings — fetches + persists settings via IPC.
 *
 * Settings are owned by main (SettingsStore). The renderer reads on mount and
 * writes on save; main is the source of truth and persists atomically.
 */

import { useCallback, useEffect, useState } from 'react';

export type Settings = Record<string, unknown> & { _version: number };

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const s = (await window.electronAPI.settings.get()) as Settings;
    setSettings(s);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (next: Settings) => {
      await window.electronAPI.settings.set(next);
      setSettings(next);
    },
    [],
  );

  return { settings, loading, save, reload };
}
