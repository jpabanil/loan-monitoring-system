"use client";

import {
  BarChartOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  DollarOutlined,
  FileExcelOutlined,
  FilePdfOutlined,
  GiftOutlined,
  HistoryOutlined,
  ProfileOutlined,
  ReconciliationOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { App, Button, Card, DatePicker } from "antd";
import dayjs from "dayjs";
import type { ReactNode } from "react";
import { Chip, PageHeader } from "@/components/ui";
import { useSession } from "@/lib/session";

const REPORTS: { key: string; title: string; desc: string; icon: ReactNode; cashier?: boolean; asOf?: boolean }[] = [
  { key: "collections", title: "Collections", desc: "Posted payments by day or period, with per-cashier subtotals. Voids excluded.", icon: <DollarOutlined />, cashier: true },
  { key: "releases", title: "Loan releases", desc: "Every loan released with principal, fees and net proceeds.", icon: <ReconciliationOutlined /> },
  { key: "outstanding", title: "Outstanding balances", desc: "Each loan's principal, interest and penalty balance as of a date.", icon: <BarChartOutlined />, asOf: true },
  { key: "aging", title: "Past due / aging", desc: "Loans by days past due: 1–30, 31–60, 61–90 and 90+.", icon: <WarningOutlined />, asOf: true },
  { key: "ledger", title: "Member ledger", desc: "Releases, payments, penalties, waivers and voids with a running balance.", icon: <ProfileOutlined /> },
  { key: "history", title: "Transaction history", desc: "All payments and reversals in a period.", icon: <HistoryOutlined /> },
  { key: "fully-paid", title: "Fully paid loans", desc: "Loans closed in the period, for fully paid notices.", icon: <CheckCircleOutlined /> },
  { key: "penalties", title: "Penalties assessed and waived", desc: "Penalty assessments and every waiver with its reason and approver.", icon: <GiftOutlined /> },
];

export default function ReportsPage() {
  const session = useSession();
  const { message } = App.useApp();
  const allowed = REPORTS.filter((r) => session.can("reports.all") || r.cashier);
  const notReady = () => message.info("Report files will generate once the reports API is connected.");

  return (
    <>
      <PageHeader title="Reports" subtitle="Every report exports to PDF (with company header) and Excel (numbers stay numeric)." />
      <section className="grid grid-2">
        {allowed.map((r) => (
          <Card key={r.key} variant="outlined">
            <div className="row" style={{ gap: 14, alignItems: "flex-start", flexWrap: "nowrap" }}>
              <span className="stat-icon" aria-hidden>{r.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="spread">
                  <span style={{ fontWeight: 700, fontSize: 16 }}>{r.title}</span>
                  {r.asOf ? <Chip tone="neutral" icon={<CalendarOutlined />}>As of a date</Chip> : null}
                </div>
                <p className="muted" style={{ margin: "6px 0 14px" }}>{r.desc}</p>
                <div className="row">
                  {r.asOf ? (
                    <DatePicker defaultValue={dayjs("2026-11-06")} format="MMM D, YYYY" aria-label={`${r.title} as of`} />
                  ) : (
                    <DatePicker.RangePicker defaultValue={[dayjs("2026-11-01"), dayjs("2026-11-06")]} format="MMM D, YYYY" aria-label={`${r.title} date range`} />
                  )}
                  <Button icon={<FilePdfOutlined />} onClick={notReady}>PDF</Button>
                  <Button icon={<FileExcelOutlined />} onClick={notReady}>Excel</Button>
                </div>
              </div>
            </div>
          </Card>
        ))}
      </section>
    </>
  );
}
