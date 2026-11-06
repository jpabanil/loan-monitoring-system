import type { IsoDate } from "@lms/shared";

const manilaDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" });

/** Today's calendar date in Asia/Manila (plan.md 2.1: timestamps UTC, business dates Manila). */
export function todayManila(now = new Date()): IsoDate {
  return manilaDate.format(now);
}
