"use client";

import { DownloadOutlined, PhoneOutlined } from "@ant-design/icons";
import { agingBucket, formatPeso, type AgingBucket } from "@lms/shared";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Empty, Table } from "antd";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BUCKET_LABEL, MemberCell, Money, PageHeader, Panel, StatusChip, fmtDate } from "@/components/ui";
import { api } from "@/lib/api";
import { fullName, type AgingBuckets, type LoanListItem, type Page } from "@/lib/types";

const BUCKETS: AgingBucket[] = ["1-30", "31-60", "61-90", "90+"];
const TONE: Record<AgingBucket, string> = { current: "good", "1-30": "warn", "31-60": "serious", "61-90": "critical", "90+": "critical" };

export default function OverduePage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [bucket, setBucket] = useState<AgingBucket | null>(null);

  const aging = useQuery({ queryKey: ["dashboard", "aging"], queryFn: () => api.get<AgingBuckets>("/dashboard/aging") });
  const pastDue = useQuery({ queryKey: ["loans", "past_due", "all"], queryFn: () => api.get<Page<LoanListItem>>("/loans?status=past_due&pageSize=100") });

  const loans = (pastDue.data?.items ?? []).slice().sort((a, b) => b.daysPastDue - a.daysPastDue);
  const rows = bucket ? loans.filter((l) => agingBucket(l.daysPastDue) === bucket) : loans;
  const totalOverdue = loans.reduce((t, l) => t + l.overdueAmount, 0);

  return (
    <>
      <PageHeader
        title="Overdue monitoring"
        subtitle={pastDue.data ? `${pastDue.data.total} past-due loans · ${formatPeso(totalOverdue)} overdue · updated by the daily job at 12:30 AM` : "Loading…"}
        actions={<Button icon={<DownloadOutlined />} onClick={() => message.info("Excel export arrives with the reports module.")}>Export list</Button>}
      />

      <section className="grid grid-4" aria-label="Aging buckets">
        {BUCKETS.map((b) => {
          const v = aging.data?.[b];
          return (
            <button key={b} type="button" className="glass stat bucket-tile" aria-pressed={bucket === b} onClick={() => setBucket((cur) => (cur === b ? null : b))}>
              <div className="stat-top">
                <span className="stat-label">{BUCKET_LABEL[b]} past due</span>
                <span className={`chip chip-${TONE[b]}`}>{v?.count ?? 0} loans</span>
              </div>
              <div className="stat-value">{formatPeso(v?.amount ?? 0)}</div>
              <div className="stat-foot">Outstanding balance · {bucket === b ? "click to show all" : "click to filter"}</div>
            </button>
          );
        })}
      </section>

      <Panel title={bucket ? `${BUCKET_LABEL[bucket]} past due` : "All past-due loans"} bodyPad={false}>
        <Table<LoanListItem>
          rowKey="id"
          loading={pastDue.isLoading}
          dataSource={rows}
          scroll={{ x: 900 }}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          rowClassName={() => "clickable-row"}
          onRow={(l) => ({ onClick: () => router.push(`/loans/${l.id}`) })}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No past-due loans" /> }}
          columns={[
            { title: "Member", render: (_, l) => <MemberCell name={fullName(l.member)} sub={l.member.memberNo} /> },
            {
              title: "Contact",
              render: (_, l) => (
                <a href={`tel:${l.member.mobile}`} onClick={(e) => e.stopPropagation()}>
                  <PhoneOutlined /> {l.member.mobile}
                </a>
              ),
            },
            { title: "Loan", render: (_, l) => <span>{l.loanNo}<div className="faint">{l.productName}</div></span> },
            { title: "Oldest due", render: (_, l) => (l.nextDueDate ? fmtDate(l.nextDueDate) : "—") },
            { title: "Days past due", align: "right", sorter: (a, b) => a.daysPastDue - b.daysPastDue, render: (_, l) => <b>{l.daysPastDue}</b> },
            { title: "Overdue", align: "right", render: (_, l) => <Money value={l.overdueAmount} strong /> },
            { title: "Penalty", align: "right", render: (_, l) => <Money value={l.penaltyBalance} /> },
            { title: "Bucket", render: (_, l) => <StatusChip status="overdue" label={BUCKET_LABEL[agingBucket(l.daysPastDue)]} /> },
          ]}
        />
      </Panel>
    </>
  );
}
