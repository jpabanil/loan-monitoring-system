/** Theme constants shared by the server layout and the client provider. */
export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_COOKIE = "lms-theme";
export const RESOLVED_THEME_COOKIE = "lms-theme-resolved";

/** Runs before first paint so CSS variables match the saved or system theme. */
export const themeBootScript = `(() => {
  try {
    const m = document.cookie.match(/(?:^|; )${THEME_COOKIE}=(light|dark|system)/);
    const mode = m ? m[1] : 'system';
    const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const resolved = dark ? 'dark' : 'light';
    document.documentElement.dataset.theme = resolved;
    document.cookie = '${RESOLVED_THEME_COOKIE}=' + resolved + '; path=/; max-age=31536000; samesite=lax';
  } catch (e) {}
})();`;
