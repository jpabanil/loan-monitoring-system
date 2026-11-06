"use client";

import { ArrowLeftOutlined, CopyOutlined, LockOutlined, MailOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { Alert, App, Button, Form, Input } from "antd";
import { useRouter, useSearchParams } from "next/navigation";
import QRCode from "qrcode";
import { Suspense, useEffect, useRef, useState } from "react";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { api, ApiError } from "@/lib/api";

type Step = "password" | "code" | "setup" | "recovery-codes";

interface LoginResponse {
  step: "totp" | "totp_setup";
  challengeToken: string;
}

/**
 * Staff sign-in (plan.md section 3): password, then a 6-digit authenticator
 * code. First sign-in sets up the authenticator and shows recovery codes once.
 */
function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { message } = App.useApp();
  const [step, setStep] = useState<Step>("password");
  const [email, setEmail] = useState("");
  const [challenge, setChallenge] = useState("");
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = params.get("next")?.startsWith("/") ? params.get("next")! : "/dashboard";

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "We couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  // Ask for a new secret once per setup (React dev mode runs effects twice; a second
  // request would replace the secret behind the QR code already on screen).
  const setupStarted = useRef(false);
  useEffect(() => {
    if (step !== "setup" || setupStarted.current) return;
    setupStarted.current = true;
    void run(async () => {
      const r = await api.post<{ secret: string; otpauthUrl: string }>("/auth/staff/2fa/setup", { challengeToken: challenge }, { noRefresh: true });
      setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 200 }) });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, challenge]);

  const restart = () => {
    setStep("password");
    setSetup(null);
    setupStarted.current = false;
    setError(null);
  };

  return (
    <div className="auth-wrap">
      <div className="auth-top">
        <ThemeSwitch />
      </div>
      <div className="glass auth-card">
        <div className="brand" style={{ padding: "0 0 22px" }}>
          <span className="brand-mark">LM</span>
          <span>
            <div className="brand-name">Loan Monitoring</div>
            <div className="brand-sub">Staff admin</div>
          </span>
        </div>

        {error ? <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} /> : null}

        {step === "password" ? (
          <>
            <h1 className="page-title" style={{ fontSize: 24 }}>Welcome back</h1>
            <p className="page-sub" style={{ marginBottom: 22 }}>Sign in with your staff account.</p>
            <Form
              layout="vertical"
              requiredMark={false}
              onFinish={(v: { email: string; password: string }) =>
                run(async () => {
                  const r = await api.post<LoginResponse>("/auth/staff/login", v, { noRefresh: true });
                  setEmail(v.email);
                  setChallenge(r.challengeToken);
                  setStep(r.step === "totp" ? "code" : "setup");
                })
              }
            >
              <Form.Item name="email" label="Work email" rules={[{ required: true, message: "Enter your work email." }, { type: "email", message: "That email doesn't look right." }]}>
                <Input size="large" prefix={<MailOutlined className="faint" />} placeholder="name@company.com" autoComplete="username" autoFocus />
              </Form.Item>
              <Form.Item name="password" label="Password" rules={[{ required: true, message: "Enter your password." }]}>
                <Input.Password size="large" prefix={<LockOutlined className="faint" />} placeholder="Password" autoComplete="current-password" />
              </Form.Item>
              <Button type="primary" htmlType="submit" size="large" block loading={busy}>
                Continue
              </Button>
            </Form>
          </>
        ) : null}

        {step === "code" ? (
          <>
            <Button type="link" icon={<ArrowLeftOutlined />} onClick={restart} style={{ padding: 0, marginBottom: 8 }}>
              Back
            </Button>
            <h1 className="page-title" style={{ fontSize: 24 }}>
              <SafetyCertificateOutlined style={{ color: "var(--brand)", marginRight: 8 }} />
              {useRecovery ? "Recovery code" : "Two-factor code"}
            </h1>
            <p className="page-sub" style={{ marginBottom: 22 }}>
              {useRecovery ? "Enter one of the recovery codes you saved when you set up two-factor." : <>Enter the 6-digit code from your authenticator app for <b>{email}</b>.</>}
            </p>
            <Form
              layout="vertical"
              requiredMark={false}
              onFinish={(v: { code?: string; recoveryCode?: string }) =>
                run(async () => {
                  await api.post("/auth/staff/2fa/verify", { challengeToken: challenge, ...v }, { noRefresh: true });
                  router.replace(next);
                })
              }
            >
              {useRecovery ? (
                <Form.Item name="recoveryCode" rules={[{ required: true, message: "Enter a recovery code." }]}>
                  <Input size="large" autoFocus autoComplete="one-time-code" />
                </Form.Item>
              ) : (
                <Form.Item name="code" rules={[{ required: true, len: 6, message: "Enter all 6 digits." }]}>
                  <Input.OTP length={6} size="large" autoFocus formatter={(s) => s.replace(/\D/g, "")} />
                </Form.Item>
              )}
              <Button type="primary" htmlType="submit" size="large" block loading={busy}>
                Verify and sign in
              </Button>
              <Button type="link" block style={{ marginTop: 8 }} onClick={() => setUseRecovery((x) => !x)}>
                {useRecovery ? "Use authenticator code instead" : "Lost your phone? Use a recovery code"}
              </Button>
            </Form>
          </>
        ) : null}

        {step === "setup" ? (
          <>
            <h1 className="page-title" style={{ fontSize: 22 }}>Set up two-factor sign-in</h1>
            <p className="page-sub" style={{ marginBottom: 16 }}>
              Scan this code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password), then enter the 6-digit code it shows.
            </p>
            {setup ? (
              <div className="stack" style={{ alignItems: "center", marginBottom: 16 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={setup.qr} alt="QR code for your authenticator app" width={180} height={180} style={{ borderRadius: 12, background: "#fff", padding: 8 }} />
                <div className="faint" style={{ textAlign: "center" }}>
                  Can't scan? Enter this key:
                  <div className="tabular" style={{ fontWeight: 600, fontSize: 13, letterSpacing: 1, marginTop: 4, wordBreak: "break-all" }}>
                    {setup.secret.match(/.{1,4}/g)?.join(" ")}
                  </div>
                </div>
              </div>
            ) : null}
            <Form
              layout="vertical"
              requiredMark={false}
              onFinish={(v: { code: string }) =>
                run(async () => {
                  const r = await api.post<{ recoveryCodes: string[] }>("/auth/staff/2fa/confirm", { challengeToken: challenge, code: v.code }, { noRefresh: true });
                  setRecoveryCodes(r.recoveryCodes);
                  setStep("recovery-codes");
                })
              }
            >
              <Form.Item name="code" rules={[{ required: true, len: 6, message: "Enter all 6 digits." }]}>
                <Input.OTP length={6} size="large" formatter={(s) => s.replace(/\D/g, "")} />
              </Form.Item>
              <Button type="primary" htmlType="submit" size="large" block loading={busy} disabled={!setup}>
                Turn on two-factor
              </Button>
            </Form>
          </>
        ) : null}

        {step === "recovery-codes" ? (
          <>
            <h1 className="page-title" style={{ fontSize: 22 }}>Save your recovery codes</h1>
            <p className="page-sub" style={{ marginBottom: 16 }}>
              Each code works once if you lose your phone. Keep them somewhere safe. They won't be shown again.
            </p>
            <div className="alloc tabular" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontWeight: 600, marginBottom: 12 }}>
              {recoveryCodes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
            <Button
              icon={<CopyOutlined />}
              block
              style={{ marginBottom: 10 }}
              onClick={() => navigator.clipboard.writeText(recoveryCodes.join("\n")).then(() => message.success("Recovery codes copied."))}
            >
              Copy codes
            </Button>
            <Button type="primary" size="large" block onClick={() => router.replace(next)}>
              I've saved them, continue
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}
