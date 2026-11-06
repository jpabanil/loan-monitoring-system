"use client";

import {
  CheckCircleFilled,
  ClockCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  MinusCircleFilled,
  StopFilled,
  SyncOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { formatPeso, type Centavos } from "@lms/shared";
import { Avatar, Card } from "antd";
import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export function StatTile({
  label,
  value,
  foot,
  icon,
  tone,
}: {
  label: string;
  value: ReactNode;
  foot?: ReactNode;
  icon?: ReactNode;
  tone?: "brand" | "good" | "warn" | "critical";
}) {
  const toneStyle =
    tone && tone !== "brand"
      ? { background: `color-mix(in srgb, var(--${tone}) 14%, transparent)`, color: `var(--${tone})` }
      : undefined;
  return (
    <div className="glass stat">
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        {icon ? (
          <span className="stat-icon" style={toneStyle} aria-hidden>
            {icon}
          </span>
        ) : null}
      </div>
      <div className="stat-value">{value}</div>
      {foot ? <div className="stat-foot">{foot}</div> : null}
    </div>
  );
}

export function Money({ value, strong }: { value: Centavos; strong?: boolean }) {
  return <span className="tabular" style={strong ? { fontWeight: 600 } : undefined}>{formatPeso(value)}</span>;
}

type Tone = "good" | "warn" | "serious" | "critical" | "info" | "neutral";

const STATUS: Record<string, { tone: Tone; label: string; icon: ReactNode }> = {
  active: { tone: "good", label: "Active", icon: <CheckCircleFilled /> },
  current: { tone: "good", label: "Current", icon: <CheckCircleFilled /> },
  paid: { tone: "good", label: "Paid", icon: <CheckCircleFilled /> },
  fully_paid: { tone: "info", label: "Fully paid", icon: <CheckCircleFilled /> },
  posted: { tone: "good", label: "Posted", icon: <CheckCircleFilled /> },
  approved: { tone: "good", label: "Approved", icon: <CheckCircleFilled /> },
  released: { tone: "info", label: "Released", icon: <CheckCircleFilled /> },
  pending: { tone: "warn", label: "Pending", icon: <ClockCircleFilled /> },
  submitted: { tone: "info", label: "Submitted", icon: <ClockCircleFilled /> },
  under_review: { tone: "warn", label: "Under review", icon: <SyncOutlined /> },
  unpaid: { tone: "neutral", label: "Unpaid", icon: <MinusCircleFilled /> },
  partial: { tone: "warn", label: "Partial", icon: <ExclamationCircleFilled /> },
  overdue: { tone: "critical", label: "Overdue", icon: <WarningFilled /> },
  past_due: { tone: "critical", label: "Past due", icon: <WarningFilled /> },
  declined: { tone: "critical", label: "Declined", icon: <CloseCircleFilled /> },
  voided: { tone: "neutral", label: "Voided", icon: <StopFilled /> },
  cancelled: { tone: "neutral", label: "Cancelled", icon: <StopFilled /> },
  suspended: { tone: "serious", label: "Suspended", icon: <StopFilled /> },
  closed: { tone: "neutral", label: "Closed", icon: <MinusCircleFilled /> },
  locked: { tone: "serious", label: "Locked", icon: <StopFilled /> },
  deactivated: { tone: "neutral", label: "Deactivated", icon: <StopFilled /> },
};

export function StatusChip({ status, label }: { status: string; label?: string }) {
  const s = STATUS[status] ?? { tone: "neutral" as Tone, label: status, icon: null };
  return (
    <span className={`chip chip-${s.tone}`}>
      {s.icon}
      {label ?? s.label}
    </span>
  );
}

export function Chip({ tone, children, icon }: { tone: Tone; children: ReactNode; icon?: ReactNode }) {
  return (
    <span className={`chip chip-${tone}`}>
      {icon}
      {children}
    </span>
  );
}

const AVATAR_COLORS = ["#6366f1", "#0ea5e9", "#14b8a6", "#f59e0b", "#ec4899", "#8b5cf6", "#22c55e", "#ef4444"];

export function initials(name: string) {
  const parts = name.split(" ").filter(Boolean);
  return `${parts[0]?.[0] ?? ""}${parts.length > 1 ? parts[parts.length - 1]![0] : ""}`.toUpperCase();
}

export function PersonAvatar({ name, size = 34 }: { name: string; size?: number }) {
  const color = AVATAR_COLORS[[...name].reduce((t, c) => t + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
  return (
    <Avatar size={size} style={{ background: `linear-gradient(135deg, ${color}, ${color}cc)`, flex: "none", fontWeight: 600, fontSize: size * 0.38 }}>
      {initials(name)}
    </Avatar>
  );
}

export function MemberCell({ name, sub }: { name: string; sub?: ReactNode }) {
  return (
    <div className="member-cell">
      <PersonAvatar name={name} />
      <div style={{ minWidth: 0 }}>
        <div className="name">{name}</div>
        {sub ? <div className="faint">{sub}</div> : null}
      </div>
    </div>
  );
}

export function Panel({ title, extra, children, bodyPad = true }: { title?: ReactNode; extra?: ReactNode; children: ReactNode; bodyPad?: boolean }) {
  return (
    <Card title={title} extra={extra} variant="outlined" styles={bodyPad ? undefined : { body: { padding: 0 } }}>
      {children}
    </Card>
  );
}

const dateFmt = new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" });

/** Calendar date ("2027-01-01") → "Jan 1, 2027". */
export function fmtDate(date: string) {
  return dateFmt.format(new Date(`${date}T00:00:00Z`));
}

/** Timestamp → Asia/Manila local time. */
export function fmtDateTime(iso: string) {
  return dateTimeFmt.format(new Date(iso));
}

export const METHOD_LABEL: Record<string, string> = { cash: "Cash", bank: "Bank transfer", e_wallet: "E-wallet", check: "Check" };

export const BUCKET_LABEL: Record<string, string> = {
  current: "Current",
  "1-30": "1–30 days",
  "31-60": "31–60 days",
  "61-90": "61–90 days",
  "90+": "90+ days",
};
