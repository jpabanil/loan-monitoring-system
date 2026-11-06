"use client";

import { CheckCircleOutlined, StopOutlined } from "@ant-design/icons";
import { allocatePayment, formatPeso, PaymentExceedsBalanceError, pesosToCentavos, type AllocationLine } from "@lms/shared";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Empty, Form, Input, InputNumber, Modal, Select, Table } from "antd";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useDebounced } from "@/components/AppShell";
import { MemberCell, METHOD_LABEL, Money, PageHeader, Panel, StatusChip, fmtDate, fmtDateTime } from "@/components/ui";
import { api, ApiError, newIdempotencyKey, qs } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import { fullName, type LoanDetail, type LoanListItem, type Page, type PaymentListItem, type PaymentMethod } from "@/lib/types";

interface PostForm {
  loanId?: string;
  amount?: number;
  receiptNo?: string;
  method: PaymentMethod;
  referenceNo?: string;
}

interface PostResult {
  payment: { id: string; receiptNo: string };
  allocation: AllocationLine[];
}

function PaymentsInner() {
  const session = useSession();
  const params = useSearchParams();
  const { modal, message } = App.useApp();
  const [form] = Form.useForm<PostForm>();
  const initial: PostForm = { method: "cash", loanId: params.get("loan") ?? undefined };
  // Tracked through onValuesChange so the summary and preview also see initial values.
  const [values, setValues] = useState<Partial<PostForm>>(initial);
  const { loanId, amount, method } = values;
  const [loanQ, setLoanQ] = useState("");
  const loanTerm = useDebounced(loanQ.trim());
  const [voiding, setVoiding] = useState<PaymentListItem | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [pageNo, setPageNo] = useState(1);
  // One key per payment attempt: a double click or a retry is recorded once (AT-PAY-07).
  const [idemKey, setIdemKey] = useState(newIdempotencyKey);

  const loanOptions = useQuery({
    queryKey: ["loans", "picker", loanTerm],
    queryFn: () => api.get<Page<LoanListItem>>(`/loans${qs({ q: loanTerm, pageSize: 20 })}`),
    enabled: session.can("payments.post"),
  });
  const loan = useQuery({ queryKey: ["loan", loanId], queryFn: () => api.get<LoanDetail>(`/loans/${loanId}`), enabled: !!loanId });
  const list = useQuery({
    queryKey: ["payments", pageNo],
    queryFn: () => api.get<Page<PaymentListItem>>(`/payments${qs({ page: pageNo, pageSize: 12 })}`),
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
  });

  const l = loan.data;
  const dueNow = l ? l.schedule.filter((r) => r.status === "overdue").reduce((t, r) => t + r.principalDue - r.principalPaid + r.interestDue - r.interestPaid + r.penaltyDue - r.penaltyPaid - r.penaltyWaived, 0) || (l.nextDue?.amount ?? 0) : 0;

  /** Preview only; the server allocates and its result is what gets recorded. */
  const preview = useMemo((): { lines?: AllocationLine[]; error?: string } => {
    if (!l || !amount) return {};
    try {
      const open = l.schedule.map((r) => ({
        seq: r.seq,
        dueDate: r.dueDate,
        penalty: r.penaltyDue - r.penaltyPaid - r.penaltyWaived,
        interest: r.interestDue - r.interestPaid,
        principal: r.principalDue - r.principalPaid,
      }));
      return { lines: allocatePayment(open, pesosToCentavos(amount.toFixed(2))) };
    } catch (e) {
      if (e instanceof PaymentExceedsBalanceError) return { error: `More than the total balance. The payoff amount is ${formatPeso(e.payoff)}.` };
      return { error: "Enter a valid amount." };
    }
  }, [l, amount]);

  const post = useAction((body: object) => api.post<PostResult>("/payments", body, { idempotencyKey: idemKey }), {
    invalidate: [["payments"], ["loan"], ["loans"], ["dashboard"]],
    onSuccess: (r) => {
      message.success(`Payment posted. OR ${r.payment.receiptNo} applied to installment ${r.allocation.map((a) => a.seq).join(", ")}.`);
      const next: PostForm = { method: "cash", loanId: undefined, amount: undefined, referenceNo: undefined, receiptNo: /^\d+$/.test(r.payment.receiptNo) ? String(Number(r.payment.receiptNo) + 1).padStart(r.payment.receiptNo.length, "0") : undefined };
      form.setFieldsValue(next);
      setValues(next);
      setIdemKey(newIdempotencyKey());
    },
  });

  const voidIt = useAction(({ id, reason }: { id: string; reason: string }) => api.post(`/payments/${id}/void`, { reason }), {
    success: "Payment voided. The loan balance has been restored and the member has been notified.",
    invalidate: [["payments"], ["loan"], ["loans"], ["dashboard"]],
    onSuccess: () => setVoiding(null),
  });

  const submit = (v: PostForm) => {
    if (!l || !v.amount || preview.error) return;
    const cents = pesosToCentavos(v.amount.toFixed(2));
    modal.confirm({
      title: `Post ${formatPeso(cents)}?`,
      content: `OR ${v.receiptNo} · ${METHOD_LABEL[v.method]} · ${l.loanNo} (${fullName(l.member)}). Applied to installment ${preview.lines?.map((x) => x.seq).join(", ")}.`,
      okText: "Post payment",
      onOk: async () => {
        try {
          await post.mutateAsync({ loanId: l.id, amount: cents, receiptNo: v.receiptNo!.trim(), method: v.method, referenceNo: v.referenceNo || undefined });
        } catch (e) {
          if (e instanceof ApiError && e.code === "OR_NUMBER_USED") form.setFields([{ name: "receiptNo", errors: [e.message] }]);
          // A rejected payment is a new attempt next time.
          setIdemKey(newIdempotencyKey());
        }
      },
    });
  };

  const setAmount = (cents: number) => {
    const v = cents / 100;
    form.setFieldValue("amount", v);
    setValues((x) => ({ ...x, amount: v }));
  };

  const canPost = session.can("payments.post");
  const pickerItems = (loanOptions.data?.items ?? []).filter((x) => x.status !== "fully_paid");

  return (
    <>
      <PageHeader title="Payments" subtitle="Post collections and void mistakes. Every posting is recorded in the ledger." />

      <section className={canPost ? "grid grid-main-side" : "grid"} style={canPost ? { gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.6fr)" } : undefined}>
        {canPost ? (
          <Panel title="Post a payment">
            <Form<PostForm> form={form} layout="vertical" requiredMark={false} onFinish={submit} initialValues={initial} onValuesChange={(_, all) => setValues(all)}>
              <Form.Item name="loanId" label="Member or loan" rules={[{ required: true, message: "Choose the loan being paid." }]}>
                <Select
                  showSearch
                  filterOption={false}
                  onSearch={setLoanQ}
                  loading={loanOptions.isFetching}
                  placeholder="Search name, member no. or loan no."
                  options={[
                    ...pickerItems.map((x) => ({ value: x.id, label: `${fullName(x.member)} · ${x.loanNo}` })),
                    ...(l && !pickerItems.some((x) => x.id === l.id) ? [{ value: l.id, label: `${fullName(l.member)} · ${l.loanNo}` }] : []),
                  ]}
                />
              </Form.Item>

              {l ? (
                <div className="alloc" style={{ marginBottom: 16 }}>
                  <div className="spread"><span className="muted">Due now</span><b className="tabular">{formatPeso(dueNow)}</b></div>
                  <div className="spread"><span className="muted">Next due date</span><span>{l.nextDue ? fmtDate(l.nextDue.dueDate) : "—"}</span></div>
                  <div className="spread"><span className="muted">Payoff amount</span><span className="tabular">{formatPeso(l.totalBalance)}</span></div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <Button size="small" onClick={() => setAmount(dueNow)}>Pay amount due</Button>
                    <Button size="small" onClick={() => setAmount(l.totalBalance)}>Pay off loan</Button>
                  </div>
                </div>
              ) : null}

              <div className="grid grid-2" style={{ gap: "0 12px" }}>
                <Form.Item name="amount" label="Amount (₱)" rules={[{ required: true, message: "Enter the amount received." }]}>
                  <InputNumber<number>
                    style={{ width: "100%" }}
                    min={0.01}
                    step={100}
                    precision={2}
                    formatter={(v) => (v === undefined || v === null || `${v}` === "" ? "" : Number(v).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}
                    parser={(v) => Number((v ?? "").replace(/[₱,\s]/g, ""))}
                    placeholder="0.00"
                  />
                </Form.Item>
                <Form.Item name="receiptNo" label="OR number" rules={[{ required: true, whitespace: true, message: "Enter the official receipt number." }]}>
                  <Input inputMode="numeric" placeholder="e.g. 000101" />
                </Form.Item>
              </div>
              <div className="grid grid-2" style={{ gap: "0 12px" }}>
                <Form.Item name="method" label="Method">
                  <Select options={Object.entries(METHOD_LABEL).map(([value, label]) => ({ value, label }))} />
                </Form.Item>
                <Form.Item name="referenceNo" label="Reference no." rules={[{ required: method !== "cash", message: "Needed for non-cash payments." }]}>
                  <Input disabled={method === "cash"} placeholder={method === "cash" ? "Not needed for cash" : "Bank / e-wallet ref."} />
                </Form.Item>
              </div>

              {preview.error ? <Alert type="error" showIcon title={preview.error} style={{ marginBottom: 16 }} /> : null}
              {preview.lines ? (
                <div className="alloc" style={{ marginBottom: 16 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>How this payment will be applied</div>
                  {preview.lines.map((x) => (
                    <div key={x.seq} className="spread tabular" style={{ fontSize: 13 }}>
                      <span className="muted">Installment {x.seq}</span>
                      <span>{x.penalty ? `Penalty ${formatPeso(x.penalty)} · ` : ""}Interest {formatPeso(x.interest)} · Principal {formatPeso(x.principal)}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              <Button type="primary" htmlType="submit" block size="large" icon={<CheckCircleOutlined />} disabled={!!preview.error} loading={post.isPending}>
                Post payment
              </Button>
            </Form>
          </Panel>
        ) : null}

        <Panel title="Recent payments" bodyPad={false}>
          <Table<PaymentListItem>
            rowKey="id"
            loading={list.isFetching && !list.data}
            dataSource={list.data?.items ?? []}
            scroll={{ x: 760 }}
            pagination={{ current: pageNo, pageSize: 12, total: list.data?.total ?? 0, onChange: setPageNo, hideOnSinglePage: true, showSizeChanger: false }}
            rowClassName={(p) => (p.status === "voided" ? "voided" : "")}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No payments yet" /> }}
            columns={[
              { title: "OR no.", render: (_, p) => <span><b>{p.receiptNo}</b><div className="faint">{fmtDateTime(p.createdAt)}</div></span> },
              { title: "Member / loan", render: (_, p) => <MemberCell name={fullName(p.member)} sub={p.loanNo} /> },
              { title: "Method", render: (_, p) => <span>{METHOD_LABEL[p.method]}{p.referenceNo ? <div className="faint">{p.referenceNo}</div> : null}</span> },
              { title: "Amount", align: "right", render: (_, p) => <Money value={p.amount} strong /> },
              { title: "Status", render: (_, p) => <span title={p.voidReason ?? undefined}><StatusChip status={p.status} /></span> },
              {
                title: "",
                width: 90,
                render: (_, p) =>
                  p.status === "posted" && session.can("payments.void") ? (
                    <Button size="small" type="text" danger icon={<StopOutlined />} onClick={() => { setVoidReason(""); setVoiding(p); }}>Void</Button>
                  ) : null,
              },
            ]}
          />
        </Panel>
      </section>

      <Modal
        open={!!voiding}
        title={voiding ? `Void OR ${voiding.receiptNo} (${formatPeso(voiding.amount)})?` : ""}
        okText="Void payment"
        okButtonProps={{ danger: true, disabled: voidReason.trim().length < 5 }}
        confirmLoading={voidIt.isPending}
        onCancel={() => setVoiding(null)}
        onOk={() => voiding && voidIt.mutate({ id: voiding.id, reason: voidReason.trim() })}
      >
        <p className="muted">The payment stays on record, marked Voided. Reversing ledger entries restore the installments it paid. You can re-post it to the right loan afterward.</p>
        <Input.TextArea rows={3} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="Reason, e.g. Wrong loan" autoFocus />
      </Modal>
    </>
  );
}

export default function PaymentsPage() {
  return (
    <Suspense>
      <PaymentsInner />
    </Suspense>
  );
}
