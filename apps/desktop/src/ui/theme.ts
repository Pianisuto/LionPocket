import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'lionpocket:theme';

const readStoredTheme = (): Theme => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // Modo privado ou armazenamento bloqueado: segue com o tema padrão.
  }
  return 'dark';
};

/** Tema persistido localmente. O escuro ameixa é o visual padrão do LionPocket. */
export const useTheme = () => {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Sem persistência não é um erro: o tema vale para esta sessão.
    }
  }, [theme]);

  const toggleTheme = useCallback(
    () => setTheme((current) => (current === 'dark' ? 'light' : 'dark')),
    [],
  );

  return { theme, toggleTheme };
};
