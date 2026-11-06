"use client";

import { App, Button, Card, Form, Input, InputNumber, Result, Select, Switch, TimePicker } from "antd";
import dayjs from "dayjs";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { PageHeader } from "@/components/ui";
import { useSession } from "@/lib/session";

export default function SettingsPage() {
  const session = useSession();
  const { message } = App.useApp();

  if (!session.can("settings.edit")) {
    return <Result status="403" title="No access" subTitle="Only Admins and Managers can change settings." />;
  }

  const save = () => message.success("Saved for this session. Settings will persist once the API is connected.");

  return (
    <>
      <PageHeader title="Settings" subtitle="Changes are recorded in the audit trail." />
      <section className="grid grid-2">
        <Card title="Appearance" variant="outlined">
          <p className="muted" style={{ marginTop: 0 }}>Choose light, dark, or follow your computer's setting. Saved on this browser.</p>
          <ThemeSwitch withLabels />
        </Card>

        <Card title="Company profile" variant="outlined">
          <Form layout="vertical" onFinish={save} initialValues={{ name: "Sample Lending Cooperative", tin: "000-000-000-000", address: "Quezon City, Metro Manila" }}>
            <Form.Item name="name" label="Company name" rules={[{ required: true }]}><Input /></Form.Item>
            <div className="grid grid-2" style={{ gap: "0 12px" }}>
              <Form.Item name="tin" label="TIN"><Input /></Form.Item>
              <Form.Item name="address" label="Address"><Input /></Form.Item>
            </div>
            <Button type="primary" htmlType="submit">Save profile</Button>
          </Form>
        </Card>

        <Card title="Payment reminders" variant="outlined">
          <Form
            layout="vertical"
            onFinish={save}
            initialValues={{ before: 3, overdueEvery: 7, quiet: [dayjs("2026-01-01T20:00"), dayjs("2026-01-01T08:00")] }}
          >
            <div className="grid grid-2" style={{ gap: "0 12px" }}>
              <Form.Item name="before" label="Days before due date"><InputNumber min={0} max={14} style={{ width: "100%" }} /></Form.Item>
              <Form.Item name="overdueEvery" label="Repeat while overdue, every (days)"><InputNumber min={1} max={30} style={{ width: "100%" }} /></Form.Item>
            </div>
            <Form.Item name="quiet" label="Quiet hours (no reminders sent)" extra="Reminders that fall in quiet hours are held until they end.">
              <TimePicker.RangePicker format="h:mm A" use12Hours minuteStep={15} style={{ width: "100%" }} />
            </Form.Item>
            <Button type="primary" htmlType="submit">Save reminders</Button>
          </Form>
        </Card>

        <Card title="Lending controls" variant="outlined">
          <Form layout="vertical" onFinish={save} initialValues={{ order: "penalty-interest-principal", excess: "next", sod: true }}>
            <Form.Item name="order" label="Payment allocation order">
              <Select options={[{ value: "penalty-interest-principal", label: "Penalty → interest → principal (oldest first)" }]} />
            </Form.Item>
            <Form.Item name="excess" label="Money beyond what is due">
              <Select options={[{ value: "next", label: "Apply to next installments (advance)" }, { value: "principal", label: "Apply to principal" }]} />
            </Form.Item>
            <Form.Item name="sod" label="Four-eyes control" valuePropName="checked" extra="Encoder cannot approve; approver cannot release; cashiers cannot void or waive.">
              <Switch disabled checkedChildren="On" />
            </Form.Item>
            <Button type="primary" htmlType="submit">Save controls</Button>
          </Form>
        </Card>
      </section>
    </>
  );
}
