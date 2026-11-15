// Light/dark theme. The choice is remembered per browser; without one, the system setting is used.
// Tailwind's `dark:` variant follows the `dark` class on <html> (see index.css).
const KEY = 'workagent.theme';

export function storedTheme() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function systemTheme() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme) {
  const t = theme ?? storedTheme() ?? systemTheme();
  document.documentElement.classList.toggle('dark', t === 'dark');
  document.documentElement.style.colorScheme = t;
  return t;
}

export function saveTheme(theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
  return applyTheme(theme);
}
