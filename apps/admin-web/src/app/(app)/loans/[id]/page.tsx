"use client";

import { ArrowLeftOutlined, CreditCardOutlined, GiftOutlined, PrinterOutlined } from "@ant-design/icons";
import { Dec, formatPeso } from "@lms/shared";
import { useQuery } from "@tanstack/react-query";
import { Button, Empty, Input, Modal, Progress, Skeleton, Table, Tabs } from "antd";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { MemberCell, METHOD_LABEL, Money, PageHeader, Panel, StatTile, StatusChip, fmtDate } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import { fullName, type Installment, type LoanDetail, type Payment } from "@/lib/types";

const remaining = (r: Installment) => r.principalDue - r.principalPaid + r.interestDue - r.interestPaid + r.penaltyDue - r.penaltyPaid - r.penaltyWaived;

export default function LoanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const router = useRouter();
  const [waiving, setWaiving] = useState(false);
  const [reason, setReason] = useState("");
  const q = useQuery({ queryKey: ["loan", id], queryFn: () => api.get<LoanDetail>(`/loans/${id}`) });

  const waive = useAction((r: string) => api.post<{ waived: number }>(`/loans/${id}/waive-penalty`, { reason: r }), {
    success: (r) => `${formatPeso(r.waived)} penalty waived. Recorded in the audit trail.`,
    invalidate: [["loan", id], ["loans"], ["dashboard"]],
    onSuccess: () => setWaiving(false),
  });

  if (q.error) {
    return (
      <Panel>
        <Empty description={q.error instanceof ApiError && q.error.status === 404 ? "This loan does not exist." : "We couldn't load this loan."}>
          <Link href="/loans">Back to loans</Link>
        </Empty>
      </Panel>
    );
  }
  const loan = q.data;
  if (!loan) return <Panel><Skeleton active paragraph={{ rows: 8 }} /></Panel>;

  const pct = Math.round((loan.paidCount / loan.schedule.length) * 100);

  return (
    <>
      <div>
        <Button type="link" icon={<ArrowLeftOutlined />} onClick={() => router.push("/loans")} style={{ paddingInline: 4 }}>
          Loans
        </Button>
      </div>
      <PageHeader
        title={loan.loanNo}
        subtitle={
          <span className="row" style={{ gap: 10 }}>
            <StatusChip status={loan.status} />
            <span>
              {loan.productName} · {loan.productSnapshot.method === "diminishing" ? "diminishing balance" : "add-on"} · {new Dec(loan.productSnapshot.interestRate).times(100).toString()}% per month · released {fmtDate(loan.releaseDate)}
            </span>
          </span>
        }
        actions={
          <>
            {session.can("penalties.waive") && loan.penaltyBalance > 0 ? (
              <Button icon={<GiftOutlined />} onClick={() => { setReason(""); setWaiving(true); }}>Waive penalty</Button>
            ) : null}
            <Button icon={<PrinterOutlined />} onClick={() => window.print()}>Print</Button>
            {session.can("payments.post") && loan.status !== "fully_paid" ? (
              <Button type="primary" icon={<CreditCardOutlined />} onClick={() => router.push(`/payments?loan=${loan.id}`)}>Post payment</Button>
            ) : null}
          </>
        }
      />

      <section className="grid grid-4">
        <StatTile label="Total outstanding" value={formatPeso(loan.totalBalance)} foot={loan.status === "fully_paid" ? "Fully paid" : "Payoff amount today"} />
        <StatTile label="Principal balance" value={formatPeso(loan.principalBalance)} foot={`of ${formatPeso(loan.principal)} released`} />
        <StatTile label="Interest balance" value={formatPeso(loan.interestBalance)} foot={`of ${formatPeso(loan.totalInterest)} scheduled`} />
        <StatTile
          label="Penalty balance"
          value={formatPeso(loan.penaltyBalance)}
          tone={loan.penaltyBalance > 0 ? "critical" : undefined}
          foot={loan.daysPastDue > 0 ? `${loan.daysPastDue} days past due` : "No overdue installments"}
        />
      </section>

      <section className="grid grid-main-side">
        <Panel bodyPad={false}>
          <Tabs
            style={{ padding: "0 16px" }}
            items={[
              {
                key: "schedule",
                label: "Amortization schedule",
                children: (
                  <div style={{ margin: "0 -16px" }}>
                    <Table<Installment>
                      rowKey="id"
                      size="middle"
                      pagination={false}
                      dataSource={loan.schedule}
                      scroll={{ x: 760 }}
                      columns={[
                        { title: "#", dataIndex: "seq", width: 52 },
                        { title: "Due date", render: (_, r) => fmtDate(r.dueDate) },
                        { title: "Principal", align: "right", render: (_, r) => <Money value={r.principalDue} /> },
                        { title: "Interest", align: "right", render: (_, r) => <Money value={r.interestDue} /> },
                        { title: "Penalty", align: "right", render: (_, r) => (r.penaltyDue ? <Money value={r.penaltyDue - r.penaltyWaived} /> : <span className="faint">—</span>) },
                        { title: "Amount due", align: "right", render: (_, r) => <Money value={r.principalDue + r.interestDue + r.penaltyDue - r.penaltyWaived} strong /> },
                        { title: "Remaining", align: "right", render: (_, r) => (remaining(r) ? <Money value={remaining(r)} /> : <span className="faint">₱0.00</span>) },
                        { title: "Status", render: (_, r) => <StatusChip status={r.status} /> },
                      ]}
                    />
                  </div>
                ),
              },
              {
                key: "payments",
                label: `Payments (${loan.payments.length})`,
                children: (
                  <div style={{ margin: "0 -16px" }}>
                    <Table<Payment>
                      rowKey="id"
                      size="middle"
                      pagination={false}
                      dataSource={loan.payments}
                      scroll={{ x: 640 }}
                      rowClassName={(p) => (p.status === "voided" ? "voided" : "")}
                      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No payments yet" /> }}
                      columns={[
                        { title: "OR no.", dataIndex: "receiptNo" },
                        { title: "Date", render: (_, p) => fmtDate(p.paymentDate) },
                        { title: "Method", render: (_, p) => METHOD_LABEL[p.method] },
                        { title: "Amount", align: "right", render: (_, p) => <Money value={p.amount} strong /> },
                        { title: "Status", render: (_, p) => <span title={p.voidReason ?? undefined}><StatusChip status={p.status} /></span> },
                      ]}
                    />
                  </div>
                ),
              },
            ]}
          />
        </Panel>

        <div className="stack" style={{ gap: 16 }}>
          <Panel title="Borrower">
            <button type="button" onClick={() => router.push(`/members?open=${loan.member.id}`)} style={{ all: "unset", cursor: "pointer" }}>
              <MemberCell name={fullName(loan.member)} sub={`${loan.member.memberNo} · ${loan.member.mobile}`} />
            </button>
          </Panel>
          <Panel title="Repayment progress">
            <div className="row" style={{ gap: 18, flexWrap: "nowrap" }}>
              <Progress type="circle" percent={pct} size={96} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 18 }}>{loan.paidCount} of {loan.schedule.length} paid</div>
                <div className="muted">{loan.schedule.length - loan.paidCount} remaining</div>
                {loan.nextDue ? <div className="faint" style={{ marginTop: 6 }}>Next: {formatPeso(loan.nextDue.amount)} on {fmtDate(loan.nextDue.dueDate)}</div> : null}
              </div>
            </div>
          </Panel>
          <Panel title="Release details">
            <dl className="kv">
              <dt>Principal</dt><dd>{formatPeso(loan.principal)}</dd>
              <dt>Processing fee</dt><dd>{formatPeso(loan.feeAmount)}</dd>
              <dt>Net proceeds</dt><dd>{formatPeso(loan.netProceeds)}</dd>
              <dt>Total payable</dt><dd>{formatPeso(loan.principal + loan.totalInterest)}</dd>
              <dt>Maturity</dt><dd>{fmtDate(loan.maturityDate)}</dd>
            </dl>
          </Panel>
        </div>
      </section>

      <Modal
        open={waiving}
        title={`Waive ${formatPeso(loan.penaltyBalance)} penalty?`}
        okText="Waive penalty"
        okButtonProps={{ disabled: reason.trim().length < 5 }}
        confirmLoading={waive.isPending}
        onCancel={() => setWaiving(false)}
        onOk={() => waive.mutate(reason.trim())}
      >
        <p className="muted">The waiver and your reason are recorded in the ledger, the audit trail and the penalty report.</p>
        <Input.TextArea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason, e.g. Hospitalization, documents provided" autoFocus />
      </Modal>
    </>
  );
}
