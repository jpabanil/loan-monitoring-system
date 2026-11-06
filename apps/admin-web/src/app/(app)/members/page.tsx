"use client";

import { CheckOutlined, IdcardOutlined, PhoneOutlined, PlusOutlined, StopOutlined } from "@ant-design/icons";
import { formatPeso } from "@lms/shared";
import { useQuery } from "@tanstack/react-query";
import { App, Button, DatePicker, Drawer, Empty, Form, Input, Modal, Segmented, Select, Skeleton, Table } from "antd";
import type { Dayjs } from "dayjs";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useDebounced } from "@/components/AppShell";
import { MemberCell, Money, PageHeader, Panel, PersonAvatar, StatusChip, fmtDate } from "@/components/ui";
import { api, ApiError, qs } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import { fullName, type MemberDetail, type MemberListItem, type MemberStatus, type Page } from "@/lib/types";

type Filter = "all" | MemberStatus;

interface NewMember {
  firstName: string;
  middleName?: string;
  lastName: string;
  birthdate: Dayjs;
  sex: "F" | "M";
  civilStatus: string;
  mobile: string;
  email?: string;
  address: string;
  employment: string;
  govIdType: string;
}

function MembersInner() {
  const session = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const { modal, message } = App.useApp();
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim());
  const [filter, setFilter] = useState<Filter>((params.get("status") as Filter) ?? "all");
  const [pageNo, setPageNo] = useState(1);
  const [openId, setOpenId] = useState<string | null>(params.get("open"));
  const [adding, setAdding] = useState(false);
  const [form] = Form.useForm<NewMember>();

  const list = useQuery({
    queryKey: ["members", filter, term, pageNo],
    queryFn: () => api.get<Page<MemberListItem>>(`/members${qs({ status: filter === "all" ? undefined : filter, q: term, page: pageNo, pageSize: 15 })}`),
    placeholderData: (prev) => prev,
  });
  const pendingCount = useQuery({ queryKey: ["members", "pending", "count"], queryFn: () => api.get<Page<MemberListItem>>("/members?status=pending&pageSize=1") });
  const detail = useQuery({ queryKey: ["member", openId], queryFn: () => api.get<MemberDetail>(`/members/${openId}`), enabled: !!openId });

  const transition = useAction(({ id, action }: { id: string; action: "approve" | "suspend" | "reactivate" }) => api.post<MemberDetail>(`/members/${id}/${action}`), {
    success: (m) => `${fullName(m)} is now ${m.status}.`,
    invalidate: [["members"], ["member"]],
  });

  const [saving, setSaving] = useState(false);

  const confirmTransition = (m: MemberDetail, action: "approve" | "suspend" | "reactivate") => {
    const verb = { approve: "Approve", suspend: "Suspend", reactivate: "Reactivate" }[action];
    modal.confirm({
      title: `${verb} ${fullName(m)}?`,
      content:
        action === "suspend"
          ? "They will not be able to apply for new loans. Existing loans and payments stay visible."
          : action === "approve"
            ? "The member becomes Active, gets a notification and can apply for loans."
            : "The member can apply for loans again.",
      okText: verb,
      okButtonProps: action === "suspend" ? { danger: true } : undefined,
      onOk: () => transition.mutateAsync({ id: m.id, action }),
    });
  };

  const submitNew = async (v: NewMember, confirmDuplicate = false) => {
    const body = { ...v, birthdate: v.birthdate.format("YYYY-MM-DD"), email: v.email || undefined, middleName: v.middleName || undefined, confirmDuplicate };
    setSaving(true);
    try {
      await api.post<MemberDetail>("/members", body).then(async (m) => {
        message.success(`${fullName(m)} registered as ${m.memberNo}.`);
        setAdding(false);
        form.resetFields();
        await list.refetch();
      });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.code === "POSSIBLE_DUPLICATE") {
        modal.confirm({ title: "Possible duplicate member", content: `${e.message.split(". Send")[0]}. Register anyway?`, okText: "Register anyway", onOk: () => submitNew(v, true) });
      } else if (e.code === "MOBILE_TAKEN") {
        form.setFields([{ name: "mobile", errors: [e.message] }]);
      } else {
        message.error(e.message);
      }
    } finally {
      setSaving(false);
    }
  };

  const m = detail.data;

  return (
    <>
      <PageHeader
        title="Members"
        subtitle={list.data ? `${list.data.total} ${filter === "all" ? "members" : filter} · ${pendingCount.data?.total ?? 0} waiting for verification` : "Loading…"}
        actions={
          session.can("members.edit") ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
              Register member
            </Button>
          ) : null
        }
      />

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
              { value: "pending", label: `Pending (${pendingCount.data?.total ?? 0})` },
              { value: "suspended", label: "Suspended" },
            ]}
          />
          <Input.Search
            placeholder="Name, member no. or mobile"
            allowClear
            onChange={(e) => {
              setQ(e.target.value);
              setPageNo(1);
            }}
            style={{ maxWidth: 320 }}
            aria-label="Search members"
          />
        </div>
        <Table<MemberListItem>
          rowKey="id"
          loading={list.isFetching && !list.data}
          dataSource={list.data?.items ?? []}
          scroll={{ x: 820 }}
          pagination={{ current: pageNo, pageSize: 15, total: list.data?.total ?? 0, onChange: setPageNo, hideOnSinglePage: true, showSizeChanger: false }}
          rowClassName={() => "clickable-row"}
          onRow={(r) => ({ onClick: () => setOpenId(r.id) })}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No members match your search" /> }}
          columns={[
            { title: "Member", render: (_, r) => <MemberCell name={fullName(r)} sub={r.memberNo} /> },
            { title: "Mobile", dataIndex: "mobile" },
            { title: "Status", render: (_, r) => <StatusChip status={r.status} /> },
            { title: "Open loans", align: "right", dataIndex: "openLoans" },
            { title: "Outstanding", align: "right", render: (_, r) => <Money value={r.outstanding} /> },
            { title: "Joined", render: (_, r) => <span>{fmtDate(r.createdAt.slice(0, 10))}<div className="faint">{r.channel === "mobile" ? "Mobile app" : "Walk-in"}</div></span> },
          ]}
        />
      </Panel>

      <Drawer
        open={!!openId}
        onClose={() => {
          setOpenId(null);
          if (params.get("open")) router.replace("/members");
        }}
        size={480}
        title={m ? fullName(m) : "Member"}
        extra={m ? <StatusChip status={m.status} /> : null}
        footer={
          m ? (
            <div className="row" style={{ justifyContent: "flex-end" }}>
              {m.status === "pending" && session.can("members.approve") ? (
                <Button type="primary" icon={<CheckOutlined />} loading={transition.isPending} onClick={() => confirmTransition(m, "approve")}>Approve registration</Button>
              ) : null}
              {m.status === "active" && session.can("members.suspend") ? (
                <Button danger icon={<StopOutlined />} onClick={() => confirmTransition(m, "suspend")}>Suspend</Button>
              ) : null}
              {m.status === "suspended" && session.can("members.suspend") ? <Button onClick={() => confirmTransition(m, "reactivate")}>Reactivate</Button> : null}
            </div>
          ) : null
        }
      >
        {!m ? (
          <Skeleton active />
        ) : (
          <div className="stack" style={{ gap: 20 }}>
            <div className="row" style={{ gap: 14 }}>
              <PersonAvatar name={fullName(m)} size={56} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 17 }}>{fullName(m)}</div>
                <div className="faint">{m.memberNo} · member since {fmtDate(m.createdAt.slice(0, 10))}</div>
              </div>
            </div>
            <dl className="kv">
              <dt><PhoneOutlined /> Mobile</dt><dd>{m.mobile}</dd>
              <dt>Email</dt><dd>{m.email ?? "—"}</dd>
              <dt>Birthdate</dt><dd>{fmtDate(m.birthdate)}</dd>
              <dt>Civil status</dt><dd>{m.civilStatus}</dd>
              <dt>Address</dt><dd>{m.address}</dd>
              <dt>Work / income</dt><dd>{m.employment}</dd>
              <dt><IdcardOutlined /> Valid ID</dt><dd>{m.govIdType}{m.govIdNumberMasked ? ` · ${m.govIdNumberMasked}` : ""}</dd>
              <dt>Registered via</dt><dd>{m.channel === "mobile" ? "Mobile app" : "Walk-in"}</dd>
            </dl>
            <div>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Loans</div>
              {m.loans.length === 0 ? <span className="muted">No loans yet.</span> : null}
              <div className="stack" style={{ gap: 8 }}>
                {m.loans.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => router.push(`/loans/${l.id}`)}
                    style={{ all: "unset", cursor: "pointer", padding: "12px 14px", borderRadius: 14, background: "var(--glass-bg-subtle)", border: "1px solid var(--glass-edge)" }}
                  >
                    <div className="spread">
                      <span><b>{l.loanNo}</b> <span className="faint">· {l.productName}</span></span>
                      <StatusChip status={l.status} />
                    </div>
                    <div className="spread faint" style={{ marginTop: 6 }}>
                      <span>Principal {formatPeso(l.principal)}</span>
                      <span>Balance {formatPeso(l.totalBalance)}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </Drawer>

      <Modal open={adding} title="Register member" onCancel={() => setAdding(false)} okText="Save member" onOk={() => form.submit()} confirmLoading={saving} width={640} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={(v) => submitNew(v)} requiredMark="optional" initialValues={{ civilStatus: "Single", govIdType: "PhilSys ID" }}>
          <div className="grid grid-3" style={{ gap: "0 12px" }}>
            <Form.Item name="firstName" label="First name" rules={[{ required: true, whitespace: true, message: "Enter the first name." }]}><Input /></Form.Item>
            <Form.Item name="middleName" label="Middle name"><Input /></Form.Item>
            <Form.Item name="lastName" label="Last name" rules={[{ required: true, whitespace: true, message: "Enter the last name." }]}><Input /></Form.Item>
          </div>
          <div className="grid grid-3" style={{ gap: "0 12px" }}>
            <Form.Item name="birthdate" label="Birthdate" rules={[{ required: true, message: "Enter the birthdate." }]}>
              <DatePicker style={{ width: "100%" }} format="MMM D, YYYY" />
            </Form.Item>
            <Form.Item name="sex" label="Sex" rules={[{ required: true, message: "Choose one." }]}>
              <Select options={[{ value: "F", label: "Female" }, { value: "M", label: "Male" }]} />
            </Form.Item>
            <Form.Item name="civilStatus" label="Civil status">
              <Select options={["Single", "Married", "Widowed", "Separated"].map((v) => ({ value: v, label: v }))} />
            </Form.Item>
          </div>
          <div className="grid grid-2" style={{ gap: "0 12px" }}>
            <Form.Item name="mobile" label="Mobile number" rules={[{ required: true, message: "Enter a mobile number." }, { pattern: /^09\d{9}$/, message: "Use 11 digits starting with 09, e.g. 09171234567." }]}>
              <Input inputMode="numeric" placeholder="09171234567" maxLength={11} />
            </Form.Item>
            <Form.Item name="email" label="Email" rules={[{ type: "email", message: "That email doesn't look right." }]}><Input /></Form.Item>
          </div>
          <Form.Item name="address" label="Address" rules={[{ required: true, min: 5, message: "Enter the home address." }]}><Input /></Form.Item>
          <div className="grid grid-2" style={{ gap: "0 12px" }}>
            <Form.Item name="employment" label="Work or income source" rules={[{ required: true, min: 2, message: "Enter the source of income." }]}><Input /></Form.Item>
            <Form.Item name="govIdType" label="Valid ID type" rules={[{ required: true }]}>
              <Select options={["PhilSys ID", "UMID", "Driver's License", "Passport", "Postal ID"].map((v) => ({ value: v, label: v }))} />
            </Form.Item>
          </div>
        </Form>
      </Modal>
    </>
  );
}

export default function MembersPage() {
  return (
    <Suspense>
      <MembersInner />
    </Suspense>
  );
}
