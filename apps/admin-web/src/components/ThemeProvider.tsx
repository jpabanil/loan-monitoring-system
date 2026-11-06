"use client";

import { App as AntApp, ConfigProvider, theme as antdTheme, type ThemeConfig } from "antd";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { RESOLVED_THEME_COOKIE, THEME_COOKIE, type ResolvedTheme, type ThemeMode } from "@/lib/theme";

export type { ResolvedTheme, ThemeMode };

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useThemeMode(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useThemeMode must be used inside ThemeProvider");
  return ctx;
}

function writeCookie(name: string, value: string) {
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
}

/** Ant Design tokens tuned for translucent "glass" surfaces in each mode. */
function buildTheme(resolved: ResolvedTheme): ThemeConfig {
  const dark = resolved === "dark";
  const surface = dark ? "rgba(23, 26, 43, 0.58)" : "rgba(255, 255, 255, 0.62)";
  const elevated = dark ? "rgba(28, 31, 52, 0.9)" : "rgba(255, 255, 255, 0.88)";
  const border = dark ? "rgba(255, 255, 255, 0.10)" : "rgba(15, 23, 42, 0.10)";
  const borderSoft = dark ? "rgba(255, 255, 255, 0.06)" : "rgba(15, 23, 42, 0.06)";
  const primary = dark ? "#8b8cf6" : "#5b5bd6";
  const hover = dark ? "rgba(139, 140, 246, 0.10)" : "rgba(91, 91, 214, 0.06)";

  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    cssVar: { key: "lms" },
    token: {
      colorPrimary: primary,
      colorInfo: primary,
      colorSuccess: dark ? "#4ade80" : "#16a34a",
      colorWarning: dark ? "#fbbf24" : "#d97706",
      colorError: dark ? "#f87171" : "#dc2626",
      colorTextBase: dark ? "#eef0f8" : "#0f172a",
      colorBgBase: dark ? "#0d1020" : "#ffffff",
      colorBgContainer: surface,
      colorBgElevated: elevated,
      colorBgLayout: "transparent",
      colorBorder: border,
      colorBorderSecondary: borderSoft,
      colorSplit: borderSoft,
      borderRadius: 12,
      borderRadiusLG: 20,
      borderRadiusSM: 8,
      controlHeight: 38,
      controlHeightLG: 46,
      fontFamily: "var(--font-sans), system-ui, -apple-system, 'Segoe UI', sans-serif",
      fontSize: 14,
      boxShadowSecondary: dark
        ? "0 16px 40px -12px rgba(0,0,0,0.65)"
        : "0 16px 40px -12px rgba(30,41,99,0.22)",
      wireframe: false,
    },
    components: {
      Layout: { bodyBg: "transparent", headerBg: "transparent", siderBg: "transparent" },
      Card: { colorBgContainer: surface, headerFontSize: 15 },
      Table: {
        colorBgContainer: "transparent",
        headerBg: dark ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.45)",
        headerSplitColor: "transparent",
        rowHoverBg: hover,
        rowSelectedBg: hover,
        rowSelectedHoverBg: hover,
        borderColor: borderSoft,
        headerColor: dark ? "#b4b9cc" : "#475569",
        cellPaddingBlock: 13,
      },
      Menu: {
        itemBg: "transparent",
        subMenuItemBg: "transparent",
        itemSelectedBg: dark ? "rgba(139,140,246,0.18)" : "rgba(91,91,214,0.12)",
        itemSelectedColor: primary,
        itemHoverBg: hover,
        itemBorderRadius: 12,
        itemHeight: 42,
        itemMarginInline: 4,
        iconSize: 17,
        collapsedIconSize: 18,
      },
      Segmented: {
        trackBg: dark ? "rgba(255,255,255,0.05)" : "rgba(15,23,42,0.05)",
        itemSelectedBg: dark ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.95)",
      },
      Input: { activeShadow: `0 0 0 3px ${dark ? "rgba(139,140,246,0.25)" : "rgba(91,91,214,0.15)"}` },
      Button: { primaryShadow: "0 8px 20px -8px rgba(91,91,214,0.7)", fontWeight: 600 },
      Modal: { contentBg: elevated, headerBg: "transparent" },
      Drawer: { colorBgElevated: elevated },
      Tabs: { itemSelectedColor: primary, inkBarColor: primary },
    },
  };
}

export function ThemeProvider({
  initialMode,
  initialResolved,
  children,
}: {
  initialMode: ThemeMode;
  initialResolved: ResolvedTheme;
  children: ReactNode;
}) {
  const [mode, setModeState] = useState<ThemeMode>(initialMode);
  const [systemDark, setSystemDark] = useState(initialResolved === "dark");

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolved: ResolvedTheme = mode === "system" ? (systemDark ? "dark" : "light") : mode;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    writeCookie(RESOLVED_THEME_COOKIE, resolved);
  }, [resolved]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    writeCookie(THEME_COOKIE, next);
  }, []);

  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);
  const themeConfig = useMemo(() => buildTheme(resolved), [resolved]);

  return (
    <ThemeContext.Provider value={value}>
      <ConfigProvider theme={themeConfig}>
        <AntApp>{children}</AntApp>
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}
