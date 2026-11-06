"use client";

import {
  AppstoreOutlined,
  AuditOutlined,
  BarChartOutlined,
  BellOutlined,
  CreditCardOutlined,
  DashboardOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SettingOutlined,
  SolutionOutlined,
  TeamOutlined,
  UserSwitchOutlined,
  WalletOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { formatPeso, ROLE_LABEL, type Permission } from "@lms/shared";
import { useQuery } from "@tanstack/react-query";
import { AutoComplete, Badge, Button, Drawer, Dropdown, Grid, Input, Menu, Popover, type MenuProps } from "antd";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api, qs } from "@/lib/api";
import { useSession } from "@/lib/session";
import { fullName, type ApplicationListItem, type LoanListItem, type MemberListItem, type Page } from "@/lib/types";
import { ThemeSwitch } from "./ThemeSwitch";
import { fmtDateTime, PersonAvatar } from "./ui";

interface NavItem {
  key: string;
  label: string;
  icon: ReactNode;
  permission?: Permission;
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Overview",
    items: [
      { key: "/dashboard", label: "Dashboard", icon: <DashboardOutlined /> },
      { key: "/overdue", label: "Overdue monitoring", icon: <WarningOutlined /> },
    ],
  },
  {
    group: "Lending",
    items: [
      { key: "/members", label: "Members", icon: <TeamOutlined /> },
      { key: "/applications", label: "Applications", icon: <SolutionOutlined />, permission: "applications.view" },
      { key: "/loans", label: "Loans", icon: <WalletOutlined /> },
      { key: "/payments", label: "Payments", icon: <CreditCardOutlined /> },
      { key: "/products", label: "Loan products", icon: <AppstoreOutlined />, permission: "products.view" },
    ],
  },
  {
    group: "Administration",
    items: [
      { key: "/reports", label: "Reports", icon: <BarChartOutlined /> },
      { key: "/staff", label: "Staff & roles", icon: <UserSwitchOutlined />, permission: "staff.manage" },
      { key: "/audit", label: "Audit trail", icon: <AuditOutlined />, permission: "audit.view" },
      { key: "/settings", label: "Settings", icon: <SettingOutlined />, permission: "settings.edit" },
    ],
  },
];

function Brand({ compact }: { compact?: boolean }) {
  return (
    <Link href="/dashboard" className="brand" style={{ color: "inherit", textDecoration: "none" }}>
      <span className="brand-mark">LM</span>
      {!compact && (
        <span>
          <div className="brand-name">Loan Monitoring</div>
          <div className="brand-sub">Staff admin</div>
        </span>
      )}
    </Link>
  );
}

function NavMenu({ collapsed, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const session = useSession();
  const router = useRouter();
  const items: MenuProps["items"] = NAV.map((g) => ({
    type: "group" as const,
    key: g.group,
    label: collapsed ? null : g.group,
    children: g.items.filter((i) => !i.permission || session.can(i.permission)).map((i) => ({ key: i.key, icon: i.icon, label: i.label })),
  }));
  const selected = NAV.flatMap((g) => g.items).find((i) => pathname === i.key || pathname.startsWith(`${i.key}/`))?.key;
  return (
    <Menu
      className="sider-menu"
      mode="inline"
      inlineCollapsed={collapsed}
      selectedKeys={selected ? [selected] : []}
      items={items}
      onClick={({ key }) => {
        router.push(key);
        onNavigate?.();
      }}
    />
  );
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim());
  const enabled = term.length >= 2;
  const members = useQuery({ queryKey: ["search-members", term], queryFn: () => api.get<Page<MemberListItem>>(`/members${qs({ q: term, pageSize: 5 })}`), enabled });
  const loans = useQuery({ queryKey: ["search-loans", term], queryFn: () => api.get<Page<LoanListItem>>(`/loans${qs({ q: term, pageSize: 5 })}`), enabled });

  const options = [
    ...(members.data?.items.length
      ? [{ label: "Members", options: members.data.items.map((m) => ({ value: `/members?open=${m.id}`, label: <span>{fullName(m)} <span className="faint">· {m.memberNo}</span></span> })) }]
      : []),
    ...(loans.data?.items.length
      ? [{ label: "Loans", options: loans.data.items.map((l) => ({ value: `/loans/${l.id}`, label: <span>{l.loanNo} <span className="faint">· {fullName(l.member)} · {formatPeso(l.totalBalance)}</span></span> })) }]
      : []),
  ];

  return (
    <AutoComplete
      value={q}
      options={enabled ? options : []}
      onSearch={setQ}
      onSelect={(v: string) => {
        setQ("");
        router.push(v);
      }}
      style={{ width: "100%", maxWidth: 420 }}
      notFoundContent={enabled && !members.isFetching && !loans.isFetching ? "No member or loan matches" : null}
    >
      <Input prefix={<SearchOutlined className="faint" />} placeholder="Search members, member no., loan no." allowClear aria-label="Search members and loans" />
    </AutoComplete>
  );
}

function Notifications() {
  const session = useSession();
  const router = useRouter();
  const apps = useQuery({
    queryKey: ["applications", "submitted", "bell"],
    queryFn: () => api.get<Page<ApplicationListItem>>(`/loan-applications${qs({ status: "submitted", pageSize: 10 })}`),
    enabled: session.can("applications.view"),
    refetchInterval: 30_000,
  });
  const pending = useQuery({
    queryKey: ["members", "pending", "bell"],
    queryFn: () => api.get<Page<MemberListItem>>(`/members${qs({ status: "pending", pageSize: 10 })}`),
    refetchInterval: 30_000,
  });

  const items = [
    ...(apps.data?.items ?? []).map((a) => ({
      key: a.id,
      title: `New application ${a.applicationNo}`,
      sub: `${fullName(a.member)} · ${formatPeso(a.amount)}`,
      at: a.createdAt,
      href: `/applications?open=${a.id}`,
    })),
    ...(pending.data?.items ?? []).map((m) => ({ key: m.id, title: "App registration to verify", sub: fullName(m), at: m.createdAt, href: `/members?open=${m.id}` })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  const content = (
    <div style={{ width: 320, maxWidth: "80vw" }} className="stack">
      {items.length === 0 ? <span className="muted">You're all caught up.</span> : null}
      {items.map((n) => (
        <button key={n.key} type="button" onClick={() => router.push(n.href)} style={{ all: "unset", cursor: "pointer", display: "block", padding: "6px 4px", borderRadius: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>{n.title}</div>
          <div className="faint">{n.sub} · {fmtDateTime(n.at)}</div>
        </button>
      ))}
    </div>
  );
  return (
    <Popover content={content} title="Needs attention" trigger="click" placement="bottomRight">
      <Badge count={items.length} size="small" offset={[-4, 4]}>
        <Button type="text" shape="circle" icon={<BellOutlined style={{ fontSize: 18 }} />} aria-label={`Notifications, ${items.length} new`} />
      </Badge>
    </Popover>
  );
}

function UserMenu() {
  const session = useSession();
  const router = useRouter();
  const screens = Grid.useBreakpoint();
  const wide = screens.md ?? true;
  const items: MenuProps["items"] = [
    { key: "who", label: <div><div style={{ fontWeight: 600 }}>{session.name}</div><div className="faint">{session.email}</div></div>, disabled: true },
    { type: "divider" },
    { key: "settings", icon: <SettingOutlined />, label: "Settings", disabled: !session.can("settings.edit") },
    { type: "divider" },
    { key: "logout", icon: <LogoutOutlined />, label: "Sign out", danger: true },
  ];
  return (
    <Dropdown
      trigger={["click"]}
      menu={{
        items,
        onClick: ({ key }) => {
          if (key === "logout") void session.signOut();
          else if (key === "settings") router.push("/settings");
        },
      }}
    >
      <button type="button" style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, padding: "4px 6px", borderRadius: 12 }} aria-label="Account menu">
        <PersonAvatar name={session.name} size={36} />
        {wide ? (
          <span style={{ lineHeight: 1.2 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>{session.name}</div>
            <div className="faint">{ROLE_LABEL[session.role]}</div>
          </span>
        ) : null}
      </button>
    </Dropdown>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  // Breakpoints are unknown until after hydration; assume desktop (the admin's main use) until then.
  const screens = Grid.useBreakpoint();
  const isDesktop = screens.lg ?? true;
  const sm = screens.sm ?? true;
  const md = screens.md ?? true;
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);

  return (
    <div className="shell">
      <aside className={`glass shell-sider${collapsed ? " collapsed" : ""}`} aria-label="Main navigation">
        <Brand compact={collapsed} />
        <NavMenu collapsed={collapsed} />
        {!collapsed && (
          <div className="sider-foot">
            <SafetyCertificateOutlined /> Signed in with two-factor
          </div>
        )}
      </aside>

      <Drawer open={drawer && !isDesktop} onClose={() => setDrawer(false)} placement="left" size={290} closable={false} styles={{ body: { padding: "18px 12px" } }}>
        <Brand />
        <NavMenu onNavigate={() => setDrawer(false)} />
      </Drawer>

      <div className="shell-main">
        <header className="glass shell-header">
          {isDesktop ? (
            <Button type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} />
          ) : (
            <Button type="text" icon={<MenuOutlined />} onClick={() => setDrawer(true)} aria-label="Open navigation" />
          )}
          <div style={{ flex: 1, minWidth: 0, display: "flex" }}>{sm ? <GlobalSearch /> : <span className="brand-name">Loan Monitoring</span>}</div>
          {md ? <ThemeSwitch /> : null}
          <Notifications />
          <UserMenu />
        </header>
        {!md ? (
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <ThemeSwitch />
          </div>
        ) : null}
        <main className="shell-content">{children}</main>
      </div>
    </div>
  );
}
