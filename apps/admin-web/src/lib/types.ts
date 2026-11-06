/** Shapes returned by the Fastify API. Money fields are integer centavos. */
import type { Centavos, InterestMethod, IsoDate, PaymentFrequency, Role } from "@lms/shared";

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Me {
  id: string;
  name: string;
  email: string;
  role: Role;
  twoFactor: boolean;
}

export type MemberStatus = "pending" | "active" | "suspended" | "closed";
export type Channel = "mobile" | "walk_in";

export interface MemberListItem {
  id: string;
  memberNo: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  mobile: string;
  status: MemberStatus;
  channel: Channel;
  createdAt: string;
  openLoans: number;
  outstanding: Centavos;
}

export interface MemberDetail extends Omit<MemberListItem, "openLoans" | "outstanding"> {
  birthdate: IsoDate;
  sex: "F" | "M";
  civilStatus: string;
  address: string;
  email: string | null;
  employment: string;
  govIdType: string;
  govIdNumberMasked: string | null;
  loans: { id: string; loanNo: string; productName: string; status: LoanStatus; principal: Centavos; totalBalance: Centavos; releaseDate: IsoDate }[];
}

export interface Product {
  id: string;
  code: string;
  name: string;
  description: string;
  interestRate: string;
  method: InterestMethod;
  frequency: PaymentFrequency;
  termsAllowed: number[];
  minAmount: Centavos;
  maxAmount: Centavos;
  feeRate: string;
  penaltyRate: string;
  graceDays: number;
  maxActiveLoans: number;
  active: boolean;
}

export type ApplicationStatus = "submitted" | "under_review" | "approved" | "declined" | "cancelled" | "released";

interface MemberRef {
  id: string;
  memberNo: string;
  firstName: string;
  lastName: string;
}

export interface ApplicationListItem {
  id: string;
  applicationNo: string;
  memberId: string;
  productId: string;
  amount: Centavos;
  term: number;
  purpose: string;
  channel: Channel;
  status: ApplicationStatus;
  encodedBy: string | null;
  approvedBy: string | null;
  createdAt: string;
  member: MemberRef;
  productName: string;
}

export interface ApplicationDetail extends Omit<ApplicationListItem, "member" | "productName"> {
  member: MemberRef & { mobile: string; status: MemberStatus };
  product: Product;
  encodedByName: string | null;
  approvedByName: string | null;
  history: { id: string; status: ApplicationStatus; changedBy: string; changedAt: string; remarks: string | null }[];
  loan: { id: string; loanNo: string } | null;
}

export type LoanStatus = "active" | "past_due" | "fully_paid" | "restructured" | "written_off";

export interface Loan {
  id: string;
  loanNo: string;
  applicationId: string;
  memberId: string;
  productId: string;
  productName: string;
  productSnapshot: { method: InterestMethod; interestRate: string; name: string };
  principal: Centavos;
  totalInterest: Centavos;
  feeAmount: Centavos;
  netProceeds: Centavos;
  releaseDate: IsoDate;
  firstDueDate: IsoDate;
  maturityDate: IsoDate;
  status: LoanStatus;
  principalBalance: Centavos;
  interestBalance: Centavos;
  penaltyBalance: Centavos;
  totalBalance: Centavos;
  daysPastDue: number;
  member: MemberRef & { mobile: string };
}

export interface LoanListItem extends Loan {
  nextDueDate: IsoDate | null;
  overdueAmount: Centavos;
  paidCount: number;
  installmentCount: number;
}

export type InstallmentStatus = "unpaid" | "partial" | "paid" | "overdue";

export interface Installment {
  id: string;
  seq: number;
  dueDate: IsoDate;
  principalDue: Centavos;
  interestDue: Centavos;
  penaltyDue: Centavos;
  principalPaid: Centavos;
  interestPaid: Centavos;
  penaltyPaid: Centavos;
  penaltyWaived: Centavos;
  status: InstallmentStatus;
}

export type PaymentMethod = "cash" | "bank" | "e_wallet" | "check";

export interface Payment {
  id: string;
  receiptNo: string;
  loanId: string;
  memberId: string;
  amount: Centavos;
  method: PaymentMethod;
  referenceNo: string | null;
  paymentDate: IsoDate;
  status: "posted" | "voided";
  voidReason: string | null;
  createdAt: string;
}

export interface PaymentListItem extends Payment {
  loanNo: string;
  member: MemberRef;
}

export interface LoanDetail extends Loan {
  paidCount: number;
  nextDue: { seq: number; dueDate: IsoDate; amount: Centavos } | null;
  schedule: Installment[];
  payments: Payment[];
}

export interface DashboardSummary {
  asOf: IsoDate;
  portfolioOutstanding: Centavos;
  openLoans: number;
  pastDueLoans: number;
  releasedThisMonth: { count: number; principal: Centavos };
  collectionsThisMonth: Centavos;
  collectionsToday: Centavos;
  receiptsToday: number;
  dueToday: Centavos;
  dueTodayCount: number;
  overdueAmount: Centavos;
}

export interface DueItem {
  loanId: string;
  loanNo: string;
  productName: string;
  memberId: string;
  firstName: string;
  lastName: string;
  mobile: string;
  seq: number;
  dueDate: IsoDate;
  amount: Centavos;
}

export type AgingBuckets = Record<"current" | "1-30" | "31-60" | "61-90" | "90+", { count: number; amount: Centavos }>;

export interface StaffUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: "active" | "deactivated";
  twoFactor: boolean;
  locked: boolean;
  lastLoginAt: string | null;
}

export interface AuditLog {
  id: number;
  actorType: string;
  actorName: string;
  action: string;
  entity: string;
  entityId: string;
  summary: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  at: string;
}

export const fullName = (m: { firstName: string; lastName: string }) => `${m.firstName} ${m.lastName}`;
