"use client";

import { CalculatorOutlined } from "@ant-design/icons";
import { buildSchedule, Dec, formatPeso, pesosToCentavos, roundCentavos, type ScheduledInstallment } from "@lms/shared";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Card, Drawer, InputNumber, Select, Skeleton, Switch, Table } from "antd";
import { useMemo, useState } from "react";
import { Chip, Money, PageHeader, StatusChip, fmtDate } from "@/components/ui";
import { api } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import type { Product } from "@/lib/types";

const pct = (rate: string) => `${new Dec(rate).times(100).toString()}%`;

export default function ProductsPage() {
  const session = useSession();
  const { modal } = App.useApp();
  const products = useQuery({ queryKey: ["products"], queryFn: () => api.get<Product[]>("/loan-products") });
  const today = new Date().toISOString().slice(0, 10);
  const setActive = useAction(({ id, active }: { id: string; active: boolean }) => api.patch<Product>(`/loan-products/${id}`, { active }), {
    success: (p) => `${p.name} ${p.active ? "activated" : "deactivated"}.`,
    invalidate: [["products"]],
  });
  const [calc, setCalc] = useState<Product | null>(null);
  const [amount, setAmount] = useState<number | null>(50000);
  const [term, setTerm] = useState<number | null>(12);

  const result = useMemo(() => {
    if (!calc || !amount || !term) return null;
    const principal = pesosToCentavos(amount.toFixed(2));
    if (principal < calc.minAmount || principal > calc.maxAmount) {
      return { error: `Amount must be between ${formatPeso(calc.minAmount)} and ${formatPeso(calc.maxAmount)}.` };
    }
    if (!calc.termsAllowed.includes(term)) return { error: "Term not allowed for this product." };
    const schedule = buildSchedule({ principal, ratePerPeriod: calc.interestRate, periods: term, method: calc.method, frequency: calc.frequency, releaseDate: today });
    return { schedule, fee: roundCentavos(new Dec(principal).times(calc.feeRate)), principal };
  }, [calc, amount, term, today]);

  const toggle = (p: Product, active: boolean) =>
    modal.confirm({
      title: `${active ? "Activate" : "Deactivate"} ${p.name}?`,
      content: active ? "Members and staff can choose it for new applications." : "It will not be offered for new applications. Existing loans are not affected.",
      okText: active ? "Activate" : "Deactivate",
      onOk: () => setActive.mutateAsync({ id: p.id, active }),
    });

  return (
    <>
      <PageHeader title="Loan products" subtitle="Each loan keeps a snapshot of its product's terms, so edits never change existing loans." />

      {products.isLoading ? <Skeleton active /> : null}
      <section className="grid grid-2">
        {(products.data ?? []).map((p) => (
          <Card key={p.id} className="product-card" variant="outlined">
            <div className="spread">
              <div>
                <div className="row" style={{ gap: 8 }}>
                  <span className="brand-mark" style={{ width: 34, height: 34, fontSize: 15, borderRadius: 10 }}>{p.code}</span>
                  <span style={{ fontWeight: 700, fontSize: 17 }}>{p.name}</span>
                </div>
                <div className="muted" style={{ marginTop: 6 }}>{p.description}</div>
              </div>
              {session.can("products.edit") ? (
                <Switch checked={p.active} onChange={(v) => toggle(p, v)} aria-label={`${p.name} active`} />
              ) : (
                <StatusChip status={p.active ? "active" : "deactivated"} label={p.active ? "Active" : "Inactive"} />
              )}
            </div>
            <dl className="kv">
              <dt>Interest</dt><dd>{pct(p.interestRate)} per month, {p.method === "diminishing" ? "diminishing balance" : "add-on (flat)"}</dd>
              <dt>Amount</dt><dd>{formatPeso(p.minAmount)} – {formatPeso(p.maxAmount)}</dd>
              <dt>Terms</dt><dd>{p.termsAllowed.join(", ")} months</dd>
              <dt>Processing fee</dt><dd>{new Dec(p.feeRate).isZero() ? "None" : `${pct(p.feeRate)}, deducted from proceeds`}</dd>
              <dt>Penalty</dt><dd>{pct(p.penaltyRate)} per month of unpaid installment after {p.graceDays} grace days</dd>
              <dt>Limit</dt><dd>{p.maxActiveLoans} active loan per member</dd>
            </dl>
            <div className="spread">
              {p.active ? <Chip tone="good">Offered in app and admin</Chip> : <Chip tone="neutral">Not offered for new loans</Chip>}
              <Button
                icon={<CalculatorOutlined />}
                onClick={() => {
                  setCalc(p);
                  setTerm(p.termsAllowed.includes(12) ? 12 : p.termsAllowed[p.termsAllowed.length - 1]!);
                  setAmount(Math.min(50000, p.maxAmount / 100));
                }}
              >
                Preview schedule
              </Button>
            </div>
          </Card>
        ))}
      </section>

      <Drawer open={!!calc} onClose={() => setCalc(null)} size={620} title={calc ? `${calc.name}: schedule preview` : ""}>
        {calc ? (
          <div className="stack" style={{ gap: 16 }}>
            <div className="grid grid-2" style={{ gap: 12 }}>
              <label>
                <div className="faint" style={{ marginBottom: 4 }}>Amount (₱)</div>
                <InputNumber<number> style={{ width: "100%" }} value={amount} onChange={setAmount} min={1} step={1000} precision={2} />
              </label>
              <label>
                <div className="faint" style={{ marginBottom: 4 }}>Term</div>
                <Select style={{ width: "100%" }} value={term} onChange={setTerm} options={calc.termsAllowed.map((t) => ({ value: t, label: `${t} months` }))} />
              </label>
            </div>
            {result && "error" in result ? <div className="chip chip-critical" style={{ whiteSpace: "normal" }}>{result.error}</div> : null}
            {result && "schedule" in result && result.schedule ? (
              <>
                <div className="grid grid-3" style={{ gap: 12 }}>
                  <div className="alloc"><div className="faint">Monthly installment</div><b className="tabular" style={{ fontSize: 18 }}>{formatPeso(result.schedule.installmentAmount)}</b></div>
                  <div className="alloc"><div className="faint">Total interest</div><b className="tabular" style={{ fontSize: 18 }}>{formatPeso(result.schedule.totalInterest)}</b></div>
                  <div className="alloc"><div className="faint">Net proceeds</div><b className="tabular" style={{ fontSize: 18 }}>{formatPeso(result.principal - result.fee)}</b></div>
                </div>
                <Table<ScheduledInstallment>
                  rowKey="seq"
                  size="small"
                  pagination={false}
                  dataSource={result.schedule.installments}
                  scroll={{ x: 520 }}
                  summary={() => (
                    <Table.Summary.Row>
                      <Table.Summary.Cell index={0} colSpan={2}><b>Total payable</b></Table.Summary.Cell>
                      <Table.Summary.Cell index={2} align="right"><Money value={result.principal} /></Table.Summary.Cell>
                      <Table.Summary.Cell index={3} align="right"><Money value={result.schedule.totalInterest} /></Table.Summary.Cell>
                      <Table.Summary.Cell index={4} align="right"><Money value={result.schedule.totalPayable} strong /></Table.Summary.Cell>
                      <Table.Summary.Cell index={5} />
                    </Table.Summary.Row>
                  )}
                  columns={[
                    { title: "#", dataIndex: "seq", width: 44 },
                    { title: "Due", render: (_, r) => fmtDate(r.dueDate) },
                    { title: "Principal", align: "right", render: (_, r) => <Money value={r.principal} /> },
                    { title: "Interest", align: "right", render: (_, r) => <Money value={r.interest} /> },
                    { title: "Installment", align: "right", render: (_, r) => <Money value={r.total} strong /> },
                    { title: "Balance", align: "right", render: (_, r) => <Money value={r.balance} /> },
                  ]}
                />
                <p className="faint">Preview assumes release today ({fmtDate(today)}). The final schedule is generated by the server at release.</p>
              </>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </>
  );
}
