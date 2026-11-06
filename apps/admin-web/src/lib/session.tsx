"use client";

import { can, type Permission, type Role } from "@lms/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Spin } from "antd";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { api } from "./api";
import type { Me } from "./types";

interface Session {
  staffId: string;
  name: string;
  email: string;
  role: Role;
  can: (permission: Permission) => boolean;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

/** Loads the signed-in staff member; the API client sends anyone signed out to /login. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/auth/me"), staleTime: 60_000, retry: false });

  const signOut = useCallback(async () => {
    await api.post("/auth/logout", {}, { noRefresh: true }).catch(() => undefined);
    qc.clear();
    router.replace("/login");
  }, [qc, router]);

  const value = useMemo<Session | null>(
    () =>
      me.data
        ? {
            staffId: me.data.id,
            name: me.data.name,
            email: me.data.email,
            role: me.data.role,
            can: (p) => can(me.data!.role, p),
            signOut,
          }
        : null,
    [me.data, signOut],
  );

  if (!value) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <Spin size="large" />
      </div>
    );
  }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
