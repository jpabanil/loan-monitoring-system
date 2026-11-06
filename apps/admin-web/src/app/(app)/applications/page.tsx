"use client";

import { CheckOutlined, CloseOutlined, EyeOutlined, MobileOutlined, PlusOutlined, ShopOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { buildSchedule, Dec, formatPeso, pesosToCentavos, roundCentavos } from "@lms/shared";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Drawer, Empty, Form, Input, InputNumber, Modal, Segmented, Select, Skeleton, Table, Timeline } from "antd";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useDebounced } from "@/components/AppShell";
import { Chip, MemberCell, Money, PageHeader, Panel, StatusChip, fmtDate, fmtDateTime } from "@/components/ui";
import { api, newIdempotencyKey, qs } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import { fullName, type ApplicationDetail, type ApplicationListItem, type ApplicationStatus, type Loan, type MemberListItem, type Page, type Product } from "@/lib/types";

type Filter = "open" | ApplicationStatus | "all";
const pct = (rate: string) => `${new Dec(rate).times(100).toString()}%`;

function NewApplication({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm<{ memberId: string; productId: string; amount: number; term: number; purpose: string }>();
  const [memberQ, setMemberQ] = useState("");
  const term = useDebounced(memberQ.trim());
  const members = useQuery({ queryKey: ["members", "active", term], queryFn: () => api.get<Page<MemberListItem>>(`/members${qs({ status: "active", q: term, pageSize: 10 })}`), enabled: open });
  const products = useQuery({ queryKey: ["products"], queryFn: () => api.get<Product[]>("/loan-products"), enabled: open });
  const productId = Form.useWatch("productId", form);
  const product = products.data?.find((p) => p.id === productId);

  const create = useAction((v: { memberId: string; productId: string; amount: number; term: number; purpose: string }) =>
    api.post<ApplicationListItem>("/loan-applications", { ...v, amount: pesosToCentavos(v.amount.toFixed(2)) }), {
    success: (a) => `Application ${a.applicationNo} encoded.`,
    invalidate: [["applications"]],
    onSuccess: () => {
      form.resetFields();
      onClose();
    },
  });

  return (
    <Modal open={open} title="New walk-in application" okText="Submit application" onOk={() => form.submit()} onCancel={onClose} confirmLoading={create.isPending} destroyOnHidden>
      <Form form={form} layout="vertical" requiredMark={false} onFinish={(v) => create.mutate(v)}>
        <Form.Item name="memberId" label="Member" rules={[{ required: true, message: "Choose an active member." }]}>
          <Select
            showSearch
            filterOption={false}
            onSearch={setMemberQ}
            placeholder="Search name, member no. or mobile"
            loading={members.isFetching}
            options={(members.data?.items ?? []).map((m) => ({ value: m.id, label: `${fullName(m)} · ${m.memberNo}` }))}
          />
        </Form.Item>
        <Form.Item name="productId" label="Loan product" rules={[{ required: true, message: "Choose a product." }]}>
          <Select options={(products.data ?? []).filter((p) => p.active).map((p) => ({ value: p.id, label: `${p.name} · ${pct(p.interestRate)}/month` }))} />
        </Form.Item>
        <div className="grid grid-2" style={{ gap: "0 12px" }}>
          <Form.Item
            name="amount"
            label="Amount (₱)"
            extra={product ? `${formatPeso(product.minAmount)} – ${formatPeso(product.maxAmount)}` : undefined}
            rules={[{ required: true, message: "Enter the amount." }]}
          >
            <InputNumber<number> style={{ width: "100%" }} min={1} step={1000} precision={2} />
          </Form.Item>
          <Form.Item name="term" label="Term" rules={[{ required: true, message: "Choose a term." }]}>
            <Select disabled={!product} options={(product?.termsAllowed ?? []).map((t) => ({ value: t, label: `${t} months` }))} />
          </Form.Item>
        </div>
        <Form.Item name="purpose" label="Purpose" rules={[{ required: true, min: 3, message: "Say what the loan is for." }]}>
          <Input placeholder="e.g. House repair" maxLength={300} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function ApplicationsInner() {
  const session = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const { modal } = App.useApp();
  const [filter, setFilter] = useState<Filter>("open");
  const [openId, setOpenId] = useState<string | null>(params.get("open"));
  const [declining, setDeclining] = useState(false);
  const [creating, setCreating] = useState(false);
  const [reason, setReason] = useState("");

  const counts = useQuery({ queryKey: ["applications", "counts"], queryFn: () => api.get<Record<ApplicationStatus, number>>("/loan-applications/counts") });
  const status = filter === "all" || filter === "open" ? undefined : filter;
  const list = useQuery({
    queryKey: ["applications", "list", filter],
    queryFn: () => api.get<Page<ApplicationListItem>>(`/loan-applications${qs({ status, pageSize: 100 })}`),
  });
  const rows = (list.data?.items ?? []).filter((a) => filter !== "open" || ["submitted", "under_review", "approved"].includes(a.status));
  const detail = useQuery({ queryKey: ["application", openId], queryFn: () => api.get<ApplicationDetail>(`/loan-applications/${openId}`), enabled: !!openId });
  const app = detail.data;

  const preview = useMemo(
    () =>
      app
        ? buildSchedule({ principal: app.amount, ratePerPeriod: app.product.interestRate, periods: app.term, method: app.product.method, frequency: app.product.frequency, releaseDate: new Date().toISOString().slice(0, 10) })
        : undefined,
    [app],
  );
  const fee = app ? roundCentavos(new Dec(app.amount).times(app.product.feeRate)) : 0;

  const invalidate = [["applications"], ["application"], ["dashboard"]];
  const move = useAction(({ id, action, body }: { id: string; action: "review" | "approve" | "decline"; body?: object }) => api.post(`/loan-applications/${id}/${action}`, body ?? {}), {
    success: "Application updated. The member has been notified.",
    invalidate,
  });
  const release = useAction(({ id, key }: { id: string; key: string }) => api.post<Loan>(`/loan-applications/${id}/release`, {}, { idempotencyKey: key }), {
    success: (l) => `Loan ${l.loanNo} released and schedule created.`,
    invalidate: [...invalidate, ["loans"], ["members"]],
    onSuccess: (l) => router.push(`/loans/${l.id}`),
  });

  const releaseBlocked = app?.status === "approved" && app.approvedBy === session.staffId;

  const confirmApprove = () =>
    app &&
    modal.confirm({
      title: `Approve ${app.applicationNo}?`,
      content: `${app.product.name} of ${formatPeso(app.amount)} for ${fullName(app.member)}, ${app.term} months. The member is notified. Another Manager or Admin will release it.`,
      okText: "Approve",
      onOk: () => move.mutateAsync({ id: app.id, action: "approve" }),
    });

  const confirmRelease = () => {
    if (!app || !preview) return;
    const key = newIdempotencyKey();
    modal.confirm({
      title: `Release ${formatPeso(app.amount)}?`,
      content: `Net proceeds ${formatPeso(app.amount - fee)}${fee ? ` after the ${formatPeso(fee)} processing fee` : ""}. ${app.term} installments of about ${formatPeso(preview.installmentAmount)} start ${fmtDate(preview.installments[0]!.dueDate)}.`,
      okText: "Release loan",
      onOk: () => release.mutateAsync({ id: app.id, key }),
    });
  };

  const c = counts.data;

  return (
    <>
      <PageHeader
        title="Loan applications"
        subtitle={c ? `${c.submitted} new · ${c.under_review} under review · ${c.approved} waiting for release` : "Loading…"}
        actions={session.can("applications.encode") ? <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>New application</Button> : null}
      />

      <Panel bodyPad={false}>
        <div style={{ padding: 16, overflowX: "auto" }}>
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: "open", label: "Open" },
              { value: "submitted", label: `Submitted (${c?.submitted ?? 0})` },
              { value: "under_review", label: `Under review (${c?.under_review ?? 0})` },
              { value: "approved", label: `Approved (${c?.approved ?? 0})` },
              { value: "declined", label: "Declined" },
              { value: "released", label: "Released" },
              { value: "all", label: "All" },
            ]}
          />
        </div>
        <Table<ApplicationListItem>
          rowKey="id"
          loading={list.isLoading}
          dataSource={rows}
          scroll={{ x: 860 }}
          pagination={{ pageSize: 15, hideOnSinglePage: true }}
          rowClassName={() => "clickable-row"}
          onRow={(a) => ({ onClick: () => setOpenId(a.id) })}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No applications here" /> }}
          columns={[
            { title: "Application", render: (_, a) => <span><b>{a.applicationNo}</b><div className="faint">{fmtDateTime(a.createdAt)}</div></span> },
            { title: "Member", render: (_, a) => <MemberCell name={fullName(a.member)} sub={a.member.memberNo} /> },
            { title: "Product", render: (_, a) => <span>{a.productName}<div className="faint">{a.term} months</div></span> },
            { title: "Amount", align: "right", render: (_, a) => <Money value={a.amount} strong /> },
            { title: "Channel", render: (_, a) => (a.channel === "mobile" ? <Chip tone="info" icon={<MobileOutlined />}>Mobile app</Chip> : <Chip tone="neutral" icon={<ShopOutlined />}>Walk-in</Chip>) },
            { title: "Status", render: (_, a) => <StatusChip status={a.status} /> },
          ]}
        />
      </Panel>

      <Drawer
        open={!!openId}
        onClose={() => setOpenId(null)}
        size={560}
        title={app?.applicationNo ?? "Application"}
        extra={app ? <StatusChip status={app.status} /> : null}
        footer={
          app ? (
            <div className="row" style={{ justifyContent: "flex-end" }}>
              {app.status === "submitted" && session.can("applications.encode") ? (
                <Button icon={<EyeOutlined />} loading={move.isPending} onClick={() => move.mutate({ id: app.id, action: "review" })}>Mark under review</Button>
              ) : null}
              {["submitted", "under_review"].includes(app.status) && session.can("applications.approve") ? (
                <>
                  <Button danger icon={<CloseOutlined />} onClick={() => { setReason(""); setDeclining(true); }}>Decline</Button>
                  <Button type="primary" icon={<CheckOutlined />} onClick={confirmApprove} disabled={app.encodedBy === session.staffId}>Approve</Button>
                </>
              ) : null}
              {app.status === "approved" && session.can("loans.release") ? (
                <Button type="primary" icon={<ThunderboltOutlined />} disabled={releaseBlocked} loading={release.isPending} onClick={confirmRelease}>Release loan</Button>
              ) : null}
              {app.loan ? <Button type="primary" onClick={() => router.push(`/loans/${app.loan!.id}`)}>Open loan {app.loan.loanNo}</Button> : null}
            </div>
          ) : null
        }
      >
        {!app || !preview ? (
          <Skeleton active />
        ) : (
          <div className="stack" style={{ gap: 20 }}>
            {releaseBlocked ? <Alert type="warning" showIcon title="You approved this application, so another Manager or Admin must release it (four-eyes rule)." /> : null}
            {["submitted", "under_review"].includes(app.status) && app.encodedBy === session.staffId && session.can("applications.approve") ? (
              <Alert type="info" showIcon title="You encoded this application, so someone else must approve it (four-eyes rule)." />
            ) : null}
            <MemberCell name={fullName(app.member)} sub={`${app.member.memberNo} · ${app.member.mobile}`} />
            <dl className="kv">
              <dt>Product</dt><dd>{app.product.name} ({app.product.method === "diminishing" ? "diminishing balance" : "add-on"}, {pct(app.product.interestRate)} per month)</dd>
              <dt>Amount</dt><dd>{formatPeso(app.amount)}</dd>
              <dt>Term</dt><dd>{app.term} monthly installments</dd>
              <dt>Purpose</dt><dd>{app.purpose}</dd>
              <dt>Processing fee</dt><dd>{fee ? `${formatPeso(fee)} (deducted from proceeds)` : "None"}</dd>
              <dt>Net proceeds</dt><dd>{formatPeso(app.amount - fee)}</dd>
              <dt>Installment</dt><dd>{formatPeso(preview.installmentAmount)} per month</dd>
              <dt>Total interest</dt><dd>{formatPeso(preview.totalInterest)}</dd>
              <dt>Total payable</dt><dd><b>{formatPeso(preview.totalPayable)}</b></dd>
              {app.encodedByName ? (<><dt>Encoded by</dt><dd>{app.encodedByName}</dd></>) : null}
              {app.approvedByName ? (<><dt>Approved by</dt><dd>{app.approvedByName}</dd></>) : null}
            </dl>
            <div>
              <div style={{ fontWeight: 700, marginBottom: 12 }}>Status history</div>
              <Timeline
                items={app.history.map((h) => ({
                  color: h.status === "declined" ? "red" : h.status === "approved" || h.status === "released" ? "green" : h.status === "cancelled" ? "gray" : "blue",
                  content: (
                    <div>
                      <StatusChip status={h.status} />
                      <div className="faint" style={{ marginTop: 4 }}>{h.changedBy} · {fmtDateTime(h.changedAt)}</div>
                      {h.remarks ? <div style={{ marginTop: 4 }}>“{h.remarks}”</div> : null}
                    </div>
                  ),
                }))}
              />
            </div>
          </div>
        )}
      </Drawer>

      <Modal
        open={declining}
        title={`Decline ${app?.applicationNo ?? ""}`}
        okText="Decline application"
        okButtonProps={{ danger: true, disabled: reason.trim().length < 5 }}
        confirmLoading={move.isPending}
        onCancel={() => setDeclining(false)}
        onOk={async () => {
          if (!app) return;
          await move.mutateAsync({ id: app.id, action: "decline", body: { reason: reason.trim() } });
          setDeclining(false);
        }}
      >
        <p className="muted">The member sees this reason in the app.</p>
        <Input.TextArea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Incomplete requirements: latest payslip missing" autoFocus />
      </Modal>

      <NewApplication open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

export default function ApplicationsPage() {
  return (
    <Suspense>
      <ApplicationsInner />
    </Suspense>
  );
}
