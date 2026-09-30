import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { database } from '../db/connection';
import {
  defaultPreferences,
  readPreferences,
  writePreferences,
  type LocalPreferences,
} from '../db/preferences';
import { darkColors, lightColors, type Palette } from './theme';

type Appearance = {
  preferences: LocalPreferences;
  colors: Palette;
  loaded: boolean;
  error: string;
  reload: () => Promise<void>;
  update: (patch: Partial<LocalPreferences>) => Promise<void>;
};
const AppearanceContext = createContext<Appearance | null>(null);
export function AppearanceProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [preferences, setPreferences] = useState(defaultPreferences);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const reload = useCallback(async () => {
    const request = ++revision.current;
    try {
      const next = await readPreferences(await database());
      if (request === revision.current) {
        setPreferences(next);
        setError('');
      }
    } catch (cause) {
      if (request === revision.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Falha ao carregar preferências.',
        );
      throw cause;
    } finally {
      if (request === revision.current) setLoaded(true);
    }
  }, []);
  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);
  const update = useCallback(
    async (patch: Partial<LocalPreferences>) => {
      await writePreferences(await database(), patch);
      await reload();
    },
    [reload],
  );
  const value = useMemo(
    () => ({
      preferences,
      loaded,
      error,
      reload,
      update,
      colors: preferences.theme === 'dark' ? darkColors : lightColors,
    }),
    [preferences, loaded, error, reload, update],
  );
  return (
    <AppearanceContext.Provider value={value}>
      {children}
    </AppearanceContext.Provider>
  );
}
export function useAppearance() {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error('Aparência indisponível.');
  return value;
}
