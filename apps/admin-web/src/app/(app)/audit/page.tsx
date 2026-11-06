"use client";

import { LockOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Result, Select, Table } from "antd";
import { useState } from "react";
import { Chip, PageHeader, Panel, fmtDateTime } from "@/components/ui";
import { api, qs } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { AuditLog, Page } from "@/lib/types";

const ENTITIES = ["loan", "payment", "loan_application", "member", "loan_product", "staff_user", "session", "permission"];
const ACTIONS = ["login", "auth.failed", "auth.locked", "rbac.denied", "member.create", "member.update", "member.approve", "member.suspend", "application.create", "application.approve", "application.decline", "loan.release", "payment.post", "payment.void", "penalty.assess", "penalty.waive", "product.update", "staff.update"];

function JsonBlock({ label, value }: { label: string; value: Record<string, unknown> | null }) {
  if (!value) return null;
  return (
    <div style={{ flex: 1, minWidth: 200 }}>
      <div className="faint" style={{ marginBottom: 4 }}>{label}</div>
      <pre className="alloc" style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap" }}>{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

export default function AuditPage() {
  const session = useSession();
  const [entity, setEntity] = useState<string | undefined>();
  const [action, setAction] = useState<string | undefined>();
  const [pageNo, setPageNo] = useState(1);
  const allowed = session.can("audit.view");
  const list = useQuery({
    queryKey: ["audit", entity, action, pageNo],
    queryFn: () => api.get<Page<AuditLog>>(`/audit-logs${qs({ entity, action, page: pageNo, pageSize: 20 })}`),
    enabled: allowed,
    placeholderData: (prev) => prev,
  });

  if (!allowed) return <Result status="403" title="No access" subTitle="The audit trail is open to Admins, Managers and Auditors." />;

  return (
    <>
      <PageHeader
        title="Audit trail"
        subtitle={<span className="row" style={{ gap: 8 }}><Chip tone="neutral" icon={<LockOutlined />}>Read-only</Chip>Entries cannot be edited or deleted, and are hash-chained and checked nightly.</span>}
      />
      <Panel bodyPad={false}>
        <div className="row" style={{ padding: 16 }}>
          <Select allowClear placeholder="Any record type" style={{ minWidth: 200 }} value={entity} onChange={(v) => { setEntity(v); setPageNo(1); }} options={ENTITIES.map((e) => ({ value: e, label: e.replace("_", " ") }))} aria-label="Filter by record type" />
          <Select allowClear showSearch placeholder="Any action" style={{ minWidth: 220 }} value={action} onChange={(v) => { setAction(v); setPageNo(1); }} options={ACTIONS.map((a) => ({ value: a, label: a }))} aria-label="Filter by action" />
        </div>
        <Table<AuditLog>
          rowKey="id"
          loading={list.isFetching && !list.data}
          dataSource={list.data?.items ?? []}
          scroll={{ x: 900 }}
          pagination={{ current: pageNo, pageSize: 20, total: list.data?.total ?? 0, onChange: setPageNo, hideOnSinglePage: true, showSizeChanger: false }}
          expandable={{
            rowExpandable: (a) => !!(a.before || a.after),
            expandedRowRender: (a) => (
              <div className="row" style={{ alignItems: "stretch", gap: 12 }}>
                <JsonBlock label="Before" value={a.before} />
                <JsonBlock label="After" value={a.after} />
              </div>
            ),
          }}
          columns={[
            { title: "When", width: 190, render: (_, a) => fmtDateTime(a.at) },
            { title: "Who", render: (_, a) => <span>{a.actorName}<div className="faint">{a.actorType}</div></span> },
            { title: "Action", render: (_, a) => <Chip tone={/denied|void|locked|failed/.test(a.action) ? "critical" : "info"}>{a.action}</Chip> },
            { title: "Record", render: (_, a) => <span>{a.entityId.length > 24 ? `${a.entityId.slice(0, 8)}…` : a.entityId}<div className="faint">{a.entity.replace("_", " ")}</div></span> },
            { title: "Summary", dataIndex: "summary" },
            { title: "IP", dataIndex: "ip", width: 110 },
          ]}
        />
      </Panel>
    </>
  );
}
