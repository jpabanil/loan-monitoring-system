"use client";

import { useQuery } from "@tanstack/react-query";
import { Empty, Input, Progress, Segmented, Table } from "antd";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDebounced } from "@/components/AppShell";
import { Chip, MemberCell, Money, PageHeader, Panel, StatusChip, fmtDate } from "@/components/ui";
import { api, qs } from "@/lib/api";
import { fullName, type LoanListItem, type LoanStatus, type Page } from "@/lib/types";

type Filter = "all" | LoanStatus;

export default function LoansPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim());
  const [pageNo, setPageNo] = useState(1);

  const list = useQuery({
    queryKey: ["loans", filter, term, pageNo],
    queryFn: () => api.get<Page<LoanListItem>>(`/loans${qs({ status: filter === "all" ? undefined : filter, q: term, page: pageNo, pageSize: 15 })}`),
    placeholderData: (prev) => prev,
  });

  return (
    <>
      <PageHeader title="Loans" subtitle={list.data ? `${list.data.total} ${filter === "all" ? "loans" : filter.replace("_", " ")}` : "Loading…"} />
      <Panel bodyPad={false}>
        <div className="spread" style={{ padding: 16, flexWrap: "wrap" }}>
          <Segmented<Filter>
            value={filter}
            onChange={(v) => {
              setFilter(v);
              setPageNo(1);
            }}
            options={[
              { value: "all", label: "All" },
              { value: "active", label: "Active" },
              { value: "past_due", label: "Past due" },
              { value: "fully_paid", label: "Fully paid" },
            ]}
          />
          <Input.Search
            placeholder="Loan no., member name or no."
            allowClear
            onChange={(e) => {
              setQ(e.target.value);
              setPageNo(1);
            }}
            style={{ maxWidth: 320 }}
            aria-label="Search loans"
          />
        </div>
        <Table<LoanListItem>
          rowKey="id"
          loading={list.isFetching && !list.data}
          dataSource={list.data?.items ?? []}
          scroll={{ x: 980 }}
          pagination={{ current: pageNo, pageSize: 15, total: list.data?.total ?? 0, onChange: setPageNo, hideOnSinglePage: true, showSizeChanger: false }}
          rowClassName={() => "clickable-row"}
          onRow={(l) => ({ onClick: () => router.push(`/loans/${l.id}`) })}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No loans yet. Release an approved application to create one." /> }}
          columns={[
            { title: "Loan", render: (_, l) => <span><b>{l.loanNo}</b><div className="faint">{l.productName}</div></span> },
            { title: "Member", render: (_, l) => <MemberCell name={fullName(l.member)} sub={l.member.memberNo} /> },
            { title: "Principal", align: "right", render: (_, l) => <Money value={l.principal} /> },
            { title: "Balance", align: "right", render: (_, l) => <Money value={l.totalBalance} strong /> },
            {
              title: "Progress",
              width: 170,
              render: (_, l) => (
                <div>
                  <Progress percent={l.installmentCount ? Math.round((l.paidCount / l.installmentCount) * 100) : 0} showInfo={false} size="small" />
                  <div className="faint">{l.paidCount} of {l.installmentCount} paid</div>
                </div>
              ),
            },
            { title: "Next due", render: (_, l) => (l.nextDueDate ? <span>{fmtDate(l.nextDueDate)}<div className="faint">{l.daysPastDue > 0 ? `${l.daysPastDue} days past due` : ""}</div></span> : "—") },
            { title: "Status", render: (_, l) => <span className="row" style={{ gap: 4 }}><StatusChip status={l.status} />{l.penaltyBalance > 0 ? <Chip tone="serious">Penalty</Chip> : null}</span> },
          ]}
        />
      </Panel>
    </>
  );
}
