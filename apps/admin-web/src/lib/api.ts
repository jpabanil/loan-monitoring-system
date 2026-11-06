/**
 * Thin client for the Fastify API. Requests go to /api/v1 on this origin; Next
 * forwards them to the API (next.config.ts), so the httpOnly session cookies
 * are first-party. On a 401 it refreshes the session once, then retries.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let refreshing: Promise<boolean> | null = null;

function refreshSession(): Promise<boolean> {
  refreshing ??= fetch("/api/v1/auth/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      setTimeout(() => (refreshing = null), 0);
    });
  return refreshing;
}

interface Options {
  idempotencyKey?: string;
  /** Skip the refresh-and-retry (used by the sign-in calls themselves). */
  noRefresh?: boolean;
}

async function request<T>(method: string, path: string, body?: unknown, opts: Options = {}): Promise<T> {
  const send = () =>
    fetch(`/api/v1${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res = await send();
  if (res.status === 401 && !opts.noRefresh && (await refreshSession())) res = await send();

  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | undefined)?.error;
    if (res.status === 401 && !opts.noRefresh && typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    }
    throw new ApiError(res.status, err?.code ?? "HTTP_ERROR", err?.message ?? "Something went wrong. Please try again.", err?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown, opts?: Options) => request<T>("POST", path, body ?? {}, opts),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
};

/** Builds a query string, dropping empty values. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
