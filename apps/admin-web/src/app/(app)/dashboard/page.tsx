"use client";

import { CalendarOutlined, RiseOutlined, WalletOutlined, WarningOutlined } from "@ant-design/icons";
import { formatPeso } from "@lms/shared";
import { useQuery } from "@tanstack/react-query";
import { Button, Empty, Segmented, Skeleton, Table, Timeline } from "antd";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AgingChart, CollectionsChart } from "@/components/charts";
import { BUCKET_LABEL, MemberCell, Money, PageHeader, Panel, StatTile, fmtDate, fmtDateTime } from "@/components/ui";
import { api, qs } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { AgingBuckets, AuditLog, DashboardSummary, DueItem, Page } from "@/lib/types";

const monthLabel = (ym: string) => new Intl.DateTimeFormat("en-PH", { month: "short", timeZone: "UTC" }).format(new Date(`${ym}-01T00:00:00Z`));

function greeting() {
  const h = Number(new Intl.DateTimeFormat("en-PH", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Manila" }).format(new Date()));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default function DashboardPage() {
  const session = useSession();
  const router = useRouter();
  const [dueRange, setDueRange] = useState<0 | 7>(0);

  const summary = useQuery({ queryKey: ["dashboard", "summary"], queryFn: () => api.get<DashboardSummary>("/dashboard/summary"), refetchInterval: 30_000 });
  const collections = useQuery({ queryKey: ["dashboard", "collections"], queryFn: () => api.get<{ month: string; amount: number; count: number; toDate: boolean }[]>("/dashboard/collections?months=6") });
  const aging = useQuery({ queryKey: ["dashboard", "aging"], queryFn: () => api.get<AgingBuckets>("/dashboard/aging") });
  const due = useQuery({ queryKey: ["dashboard", "due", dueRange], queryFn: () => api.get<DueItem[]>(`/dashboard/due?days=${dueRange}`) });
  const activity = useQuery({
    queryKey: ["audit", "recent"],
    queryFn: () => api.get<Page<AuditLog>>(`/audit-logs${qs({ pageSize: 7 })}`),
    enabled: session.can("audit.view"),
    refetchInterval: 30_000,
  });

  const s = summary.data;
  const firstName = session.name.split(" ")[0];

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        subtitle={s ? `Here's the loan book as of ${fmtDate(s.asOf)}.` : "Loading the loan book…"}
        actions={
          <>
            {session.can("payments.post") ? <Button type="primary" onClick={() => router.push("/payments")}>Post payment</Button> : null}
            <Button onClick={() => router.push("/reports")}>Reports</Button>
          </>
        }
      />

      <section className="grid grid-4" aria-label="Key figures">
        {!s ? (
          [0, 1, 2, 3].map((i) => (
            <div key={i} className="glass stat">
              <Skeleton active paragraph={{ rows: 1 }} />
            </div>
          ))
        ) : (
          <>
            <StatTile label="Portfolio outstanding" value={formatPeso(s.portfolioOutstanding)} icon={<WalletOutlined />} foot={`${s.openLoans} open loans · ${s.releasedThisMonth.count} released this month`} />
            <StatTile label="Collections this month" value={formatPeso(s.collectionsThisMonth)} icon={<RiseOutlined />} tone="good" foot={`${formatPeso(s.collectionsToday)} collected today · ${s.receiptsToday} receipts`} />
            <StatTile label="Due today" value={formatPeso(s.dueToday)} icon={<CalendarOutlined />} tone="warn" foot={`${s.dueTodayCount} installments due ${fmtDate(s.asOf)}`} />
            <StatTile
              label="Past due"
              value={formatPeso(s.overdueAmount)}
              icon={<WarningOutlined />}
              tone="critical"
              foot={`${s.pastDueLoans} loans · ${s.portfolioOutstanding ? ((s.overdueAmount / s.portfolioOutstanding) * 100).toFixed(1) : "0.0"}% of portfolio`}
            />
          </>
        )}
      </section>

      <section className="grid grid-main-side">
        <Panel title="Collections by month" extra={<span className="faint">Posted payments, voids excluded</span>}>
          {collections.data ? (
            <CollectionsChart data={collections.data.map((m) => ({ month: m.toDate ? `${monthLabel(m.month)} (to date)` : monthLabel(m.month), amount: m.amount, count: m.count }))} />
          ) : (
            <Skeleton active />
          )}
        </Panel>
        <Panel title="Outstanding by days past due" extra={<Link href="/overdue">Open</Link>}>
          {aging.data ? (
            <AgingChart data={(Object.keys(BUCKET_LABEL) as (keyof AgingBuckets)[]).map((b) => ({ bucket: BUCKET_LABEL[b]!, amount: aging.data[b].amount, count: aging.data[b].count }))} />
          ) : (
            <Skeleton active />
          )}
        </Panel>
      </section>

      <section className="grid grid-main-side">
        <Panel
          title="Upcoming installments"
          bodyPad={false}
          extra={
            <Segmented
              size="small"
              value={dueRange}
              onChange={(v) => setDueRange(v as 0 | 7)}
              options={[
                { value: 0, label: "Today" },
                { value: 7, label: "Next 7 days" },
              ]}
            />
          }
        >
          <Table<DueItem>
            rowKey={(r) => `${r.loanId}-${r.seq}`}
            size="middle"
            pagination={false}
            loading={due.isLoading}
            dataSource={due.data ?? []}
            scroll={{ x: 560 }}
            rowClassName={() => "clickable-row"}
            onRow={(r) => ({ onClick: () => router.push(`/loans/${r.loanId}`) })}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing due in this range" /> }}
            columns={[
              { title: "Member", render: (_, r) => <MemberCell name={`${r.firstName} ${r.lastName}`} sub={r.mobile} /> },
              { title: "Loan", render: (_, r) => <span><div>{r.loanNo}</div><div className="faint">{r.productName} · #{r.seq}</div></span> },
              { title: "Due", render: (_, r) => fmtDate(r.dueDate) },
              { title: "Amount", align: "right", render: (_, r) => <Money value={r.amount} strong /> },
            ]}
          />
        </Panel>
        <Panel title="Recent activity" extra={session.can("audit.view") ? <Link href="/audit">Audit trail</Link> : null}>
          {!session.can("audit.view") ? (
            <span className="muted">Recent activity is visible to Admins, Managers and Auditors.</span>
          ) : activity.data?.items.length ? (
            <Timeline
              items={activity.data.items.map((a) => ({
                color: /void|denied|decline|locked|failed/.test(a.action) ? "red" : a.action.startsWith("payment") ? "green" : "blue",
                content: (
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{a.summary}</div>
                    <div className="faint">{a.actorName} · {fmtDateTime(a.at)}</div>
                  </div>
                ),
              }))}
            />
          ) : activity.isLoading ? (
            <Skeleton active />
          ) : (
            <span className="muted">No activity yet.</span>
          )}
        </Panel>
      </section>
    </>
  );
}
