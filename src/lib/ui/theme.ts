export type Theme = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'dealflow-theme'

export function isTheme(v: unknown): v is Theme {
  return v === 'system' || v === 'light' || v === 'dark'
}

/** Resolve a preference to the concrete theme that should be painted. */
export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === 'system') return prefersDark ? 'dark' : 'light'
  return theme
}

/**
 * Runs in <head> BEFORE first paint, so the correct palette is on <html> before
 * the browser draws anything (no flash of the wrong theme). Kept dependency-free
 * and self-contained because it is injected as a raw string, and wrapped in
 * try/catch because Safari private mode throws on localStorage access.
 */
export const THEME_INIT_SCRIPT = `(function(){try{
var t=localStorage.getItem('${THEME_STORAGE_KEY}');
if(t!=='light'&&t!=='dark'&&t!=='system')t='system';
var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
document.documentElement.setAttribute('data-theme',d?'dark':'light');
}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`
