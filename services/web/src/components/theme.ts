import { useCallback, useEffect, useState } from 'react';

const KEY = 'tabledb.theme';
type Theme = 'light' | 'dark';
const systemTheme = (): Theme => (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const stored = (): Theme | null => { try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null; } catch { return null; } };

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? systemTheme());
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const toggle = useCallback(() => setTheme((t) => { const n = t === 'dark' ? 'light' : 'dark'; try { localStorage.setItem(KEY, n); } catch { /* ignore */ } return n; }), []);
  return { theme, toggle };
}
