/**
 * Staff roles and permissions from plan.md section 3. The API enforces these
 * on every request; the admin web uses the same table only to hide what a role
 * cannot do.
 */
export type Role = "admin" | "manager" | "loan_officer" | "cashier" | "auditor";

export const ROLES: readonly Role[] = ["admin", "manager", "loan_officer", "cashier", "auditor"];

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  manager: "Manager",
  loan_officer: "Loan Officer",
  cashier: "Cashier",
  auditor: "Auditor",
};

export type Permission =
  | "dashboard.view"
  | "members.view"
  | "members.edit"
  | "members.approve"
  | "members.suspend"
  | "products.view"
  | "products.edit"
  | "applications.view"
  | "applications.encode"
  | "applications.approve"
  | "loans.view"
  | "loans.release"
  | "payments.view"
  | "payments.post"
  | "payments.void"
  | "penalties.waive"
  | "reports.all"
  | "reports.collections"
  | "audit.view"
  | "staff.manage"
  | "settings.edit";

const ALL: Role[] = ["admin", "manager", "loan_officer", "cashier", "auditor"];

const GRANTS: Record<Permission, Role[]> = {
  "dashboard.view": ALL,
  "members.view": ALL,
  "members.edit": ["admin", "manager", "loan_officer"],
  "members.approve": ["admin", "manager", "loan_officer"],
  "members.suspend": ["admin", "manager"],
  "products.view": ["admin", "manager", "loan_officer", "auditor"],
  "products.edit": ["admin", "manager"],
  "applications.view": ["admin", "manager", "loan_officer", "auditor"],
  "applications.encode": ["admin", "manager", "loan_officer"],
  "applications.approve": ["admin", "manager"],
  "loans.view": ALL,
  "loans.release": ["admin", "manager"],
  "payments.view": ALL,
  "payments.post": ["admin", "manager", "cashier"],
  "payments.void": ["admin", "manager"],
  "penalties.waive": ["admin", "manager"],
  "reports.all": ["admin", "manager", "loan_officer", "auditor"],
  "reports.collections": ALL,
  "audit.view": ["admin", "manager", "auditor"],
  "staff.manage": ["admin"],
  "settings.edit": ["admin", "manager"],
};

export function can(role: Role, permission: Permission): boolean {
  return GRANTS[permission].includes(role);
}
