"use client";

import { LockOutlined, PlusOutlined, SafetyCertificateOutlined, UnlockOutlined } from "@ant-design/icons";
import { ROLE_LABEL, ROLES, type Role } from "@lms/shared";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Dropdown, Form, Input, Modal, Result, Select, Table } from "antd";
import { useState } from "react";
import { Chip, MemberCell, PageHeader, Panel, StatusChip, fmtDateTime } from "@/components/ui";
import { api } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import type { StaffUser } from "@/lib/types";

export default function StaffPage() {
  const session = useSession();
  const { modal } = App.useApp();
  const [adding, setAdding] = useState(false);
  const [form] = Form.useForm<{ name: string; email: string; role: Role; temporaryPassword: string }>();
  const allowed = session.can("staff.manage");
  const staff = useQuery({ queryKey: ["staff"], queryFn: () => api.get<StaffUser[]>("/staff-users"), enabled: allowed });

  const act = useAction(({ id, path, body }: { id: string; path: string; body?: object }) => (path === "patch" ? api.patch<StaffUser>(`/staff-users/${id}`, body) : api.post<StaffUser>(`/staff-users/${id}/${path}`)), {
    success: "Account updated. Recorded in the audit trail.",
    invalidate: [["staff"]],
  });
  const create = useAction((body: object) => api.post<StaffUser>("/staff-users", body), {
    success: (u) => `${u.name} added. They set up two-factor at first sign-in.`,
    invalidate: [["staff"]],
    onSuccess: () => {
      setAdding(false);
      form.resetFields();
    },
  });

  if (!allowed) return <Result status="403" title="Admins only" subTitle="Ask an Admin to manage staff accounts and roles." />;

  const confirm = (title: string, content: string, run: () => Promise<unknown>) => modal.confirm({ title, content, onOk: run });

  return (
    <>
      <PageHeader
        title="Staff & roles"
        subtitle="Every staff account signs in with a password and an authenticator code."
        actions={<Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>Add staff</Button>}
      />
      <Panel bodyPad={false}>
        <Table<StaffUser>
          rowKey="id"
          loading={staff.isLoading}
          dataSource={staff.data ?? []}
          pagination={false}
          scroll={{ x: 820 }}
          columns={[
            { title: "Staff", render: (_, s) => <MemberCell name={s.name} sub={s.email} /> },
            { title: "Role", render: (_, s) => <Chip tone="info">{ROLE_LABEL[s.role]}</Chip> },
            { title: "Status", render: (_, s) => <span className="row" style={{ gap: 4 }}><StatusChip status={s.status} />{s.locked ? <StatusChip status="locked" /> : null}</span> },
            {
              title: "Two-factor",
              render: (_, s) =>
                s.twoFactor ? <Chip tone="good" icon={<SafetyCertificateOutlined />}>Set up</Chip> : <Chip tone="warn" icon={<SafetyCertificateOutlined />}>Setup on next sign-in</Chip>,
            },
            { title: "Last sign-in", render: (_, s) => (s.lastLoginAt ? fmtDateTime(s.lastLoginAt) : <span className="faint">Never</span>) },
            {
              title: "",
              width: 120,
              render: (_, s) => (
                <Dropdown
                  trigger={["click"]}
                  menu={{
                    items: [
                      { key: "unlock", icon: <UnlockOutlined />, label: "Unlock account", disabled: !s.locked },
                      { key: "reset2fa", icon: <SafetyCertificateOutlined />, label: "Reset two-factor", disabled: !s.twoFactor },
                      {
                        key: "role",
                        label: "Change role",
                        disabled: s.id === session.staffId,
                        children: ROLES.filter((r) => r !== s.role).map((r) => ({ key: `role:${r}`, label: ROLE_LABEL[r] })),
                      },
                      { key: "toggle", icon: <LockOutlined />, label: s.status === "deactivated" ? "Reactivate" : "Deactivate", danger: s.status !== "deactivated", disabled: s.id === session.staffId },
                    ],
                    onClick: ({ key }) => {
                      if (key === "unlock") confirm(`Unlock ${s.name}?`, "They can sign in again right away.", () => act.mutateAsync({ id: s.id, path: "unlock" }));
                      if (key === "reset2fa")
                        confirm(`Reset two-factor for ${s.name}?`, "Their authenticator and recovery codes stop working and they are signed out. They set up a new one at next sign-in.", () =>
                          act.mutateAsync({ id: s.id, path: "reset-2fa" }),
                        );
                      if (key.startsWith("role:")) {
                        const role = key.slice(5) as Role;
                        confirm(`Make ${s.name} ${ROLE_LABEL[role]}?`, "Their permissions change on their next request.", () => act.mutateAsync({ id: s.id, path: "patch", body: { role } }));
                      }
                      if (key === "toggle") {
                        const status = s.status === "deactivated" ? "active" : "deactivated";
                        confirm(
                          `${status === "active" ? "Reactivate" : "Deactivate"} ${s.name}?`,
                          status === "active" ? "They can sign in again." : "They are signed out everywhere and cannot sign in.",
                          () => act.mutateAsync({ id: s.id, path: "patch", body: { status } }),
                        );
                      }
                    },
                  }}
                >
                  <Button size="small">Manage</Button>
                </Dropdown>
              ),
            },
          ]}
        />
      </Panel>

      <Modal open={adding} title="Add staff account" okText="Add staff" onOk={() => form.submit()} onCancel={() => setAdding(false)} confirmLoading={create.isPending} destroyOnHidden>
        <Form form={form} layout="vertical" requiredMark={false} onFinish={(v) => create.mutate(v)} initialValues={{ role: "loan_officer" }}>
          <Form.Item name="name" label="Full name" rules={[{ required: true, min: 2, message: "Enter their full name." }]}><Input /></Form.Item>
          <Form.Item name="email" label="Work email" rules={[{ required: true, type: "email", message: "Enter a valid email." }]}><Input /></Form.Item>
          <Form.Item name="role" label="Role">
            <Select options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
          </Form.Item>
          <Form.Item
            name="temporaryPassword"
            label="Temporary password"
            extra="Share it privately. They change it after signing in."
            rules={[
              { required: true, message: "Set a temporary password." },
              { min: 8, message: "Use at least 8 characters." },
              { pattern: /(?=.*[A-Za-z])(?=.*\d)/, message: "Include letters and numbers." },
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
