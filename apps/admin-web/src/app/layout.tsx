import { AntdRegistry } from "@ant-design/nextjs-registry";
import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { QueryProvider } from "@/components/QueryProvider";
import { ThemeProvider } from "@/components/ThemeProvider";
import { RESOLVED_THEME_COOKIE, THEME_COOKIE, themeBootScript, type ResolvedTheme, type ThemeMode } from "@/lib/theme";
import "./globals.css";

const sans = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Loan Monitoring", template: "%s · Loan Monitoring" },
  description: "Loan Monitoring System: staff admin",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eef1f8" },
    { media: "(prefers-color-scheme: dark)", color: "#080a14" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const store = await cookies();
  const savedMode = store.get(THEME_COOKIE)?.value;
  const mode: ThemeMode = savedMode === "light" || savedMode === "dark" ? savedMode : "system";
  const resolved: ResolvedTheme =
    mode === "system" ? (store.get(RESOLVED_THEME_COOKIE)?.value === "dark" ? "dark" : "light") : mode;

  return (
    <html lang="en" data-theme={resolved} className={sans.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        <AntdRegistry>
          <ThemeProvider initialMode={mode} initialResolved={resolved}>
            <QueryProvider>{children}</QueryProvider>
          </ThemeProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
