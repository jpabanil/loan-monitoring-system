"use client";

import { DesktopOutlined, MoonOutlined, SunOutlined } from "@ant-design/icons";
import { Segmented, Tooltip } from "antd";
import { useThemeMode, type ThemeMode } from "./ThemeProvider";

const OPTIONS: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
  { value: "light", label: "Light", icon: <SunOutlined /> },
  { value: "dark", label: "Dark", icon: <MoonOutlined /> },
  { value: "system", label: "System", icon: <DesktopOutlined /> },
];

export function ThemeSwitch({ withLabels = false }: { withLabels?: boolean }) {
  const { mode, setMode } = useThemeMode();
  return (
    <Segmented<ThemeMode>
      value={mode}
      onChange={setMode}
      aria-label="Colour theme"
      options={OPTIONS.map((o) => ({
        value: o.value,
        label: withLabels ? (
          <span className="row" style={{ gap: 6, padding: "0 4px" }}>
            {o.icon}
            {o.label}
          </span>
        ) : (
          <Tooltip title={`${o.label} theme`}>
            <span aria-label={`${o.label} theme`}>{o.icon}</span>
          </Tooltip>
        ),
      }))}
    />
  );
}
