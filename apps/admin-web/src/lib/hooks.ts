"use client";

import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { App } from "antd";
import { ApiError } from "./api";

/**
 * A mutation that shows the API's plain-language error, shows a success
 * message, and refreshes the listed queries afterwards.
 */
export function useAction<TVars, TResult>(
  fn: (vars: TVars) => Promise<TResult>,
  opts: { success?: string | ((r: TResult) => string); invalidate?: QueryKey[]; onSuccess?: (r: TResult) => void } = {},
) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (r) => {
      if (opts.success) message.success(typeof opts.success === "function" ? opts.success(r) : opts.success);
      await Promise.all((opts.invalidate ?? []).map((k) => qc.invalidateQueries({ queryKey: k })));
      opts.onSuccess?.(r);
    },
    onError: (e) => {
      message.error(e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
    },
  });
}
