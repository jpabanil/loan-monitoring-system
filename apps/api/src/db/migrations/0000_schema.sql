CREATE TYPE "public"."application_status" AS ENUM('submitted', 'under_review', 'approved', 'declined', 'cancelled', 'released');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('mobile', 'walk_in');--> statement-breakpoint
CREATE TYPE "public"."payment_frequency" AS ENUM('weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."installment_status" AS ENUM('unpaid', 'partial', 'paid', 'overdue');--> statement-breakpoint
CREATE TYPE "public"."interest_method" AS ENUM('diminishing', 'add_on');--> statement-breakpoint
CREATE TYPE "public"."ledger_component" AS ENUM('principal', 'interest', 'penalty', 'fee');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('release', 'fee', 'interest', 'penalty', 'penalty_waiver', 'payment', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."loan_status" AS ENUM('active', 'past_due', 'fully_paid', 'restructured', 'written_off');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('pending', 'active', 'suspended', 'closed');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'bank', 'e_wallet', 'check');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('posted', 'voided');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('admin', 'manager', 'loan_officer', 'cashier', 'auditor');--> statement-breakpoint
CREATE TYPE "public"."staff_status" AS ENUM('active', 'deactivated');--> statement-breakpoint
CREATE SEQUENCE "public"."application_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."loan_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."member_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "application_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"status" "application_status" NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"remarks" text
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"actor_name" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"summary" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"ip" "inet",
	"user_agent" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"key" text NOT NULL,
	"endpoint" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL,
	"schedule_version" integer DEFAULT 1 NOT NULL,
	"seq" integer NOT NULL,
	"due_date" date NOT NULL,
	"principal_due" bigint NOT NULL,
	"interest_due" bigint NOT NULL,
	"penalty_due" bigint DEFAULT 0 NOT NULL,
	"principal_paid" bigint DEFAULT 0 NOT NULL,
	"interest_paid" bigint DEFAULT 0 NOT NULL,
	"penalty_paid" bigint DEFAULT 0 NOT NULL,
	"penalty_waived" bigint DEFAULT 0 NOT NULL,
	"status" "installment_status" DEFAULT 'unpaid' NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "installments_paid_chk" CHECK ("installments"."principal_paid" between 0 and "installments"."principal_due"
        and "installments"."interest_paid" between 0 and "installments"."interest_due"
        and "installments"."penalty_paid" >= 0 and "installments"."penalty_waived" >= 0
        and "installments"."penalty_paid" + "installments"."penalty_waived" <= "installments"."penalty_due")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"installment_id" uuid,
	"entry_type" "ledger_entry_type" NOT NULL,
	"component" "ledger_component" NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text DEFAULT 'PHP' NOT NULL,
	"payment_id" uuid,
	"penalty_assessment_id" uuid,
	"reverses_entry_id" uuid,
	"memo" text,
	"effective_date" date NOT NULL,
	"posted_by" text NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_amount_chk" CHECK ("ledger_entries"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "loan_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_no" text NOT NULL,
	"member_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"term" integer NOT NULL,
	"purpose" text NOT NULL,
	"channel" "channel" NOT NULL,
	"status" "application_status" DEFAULT 'submitted' NOT NULL,
	"encoded_by" uuid,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_applications_amount_chk" CHECK ("loan_applications"."amount" > 0 and "loan_applications"."term" > 0)
);
--> statement-breakpoint
CREATE TABLE "loan_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"interest_rate" numeric(9, 6) NOT NULL,
	"method" "interest_method" NOT NULL,
	"frequency" "payment_frequency" NOT NULL,
	"terms_allowed" integer[] NOT NULL,
	"min_amount" bigint NOT NULL,
	"max_amount" bigint NOT NULL,
	"fee_rate" numeric(9, 6) DEFAULT '0' NOT NULL,
	"penalty_rate" numeric(9, 6) NOT NULL,
	"grace_days" integer NOT NULL,
	"max_active_loans" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_products_amounts_chk" CHECK ("loan_products"."min_amount" > 0 and "loan_products"."min_amount" <= "loan_products"."max_amount"),
	CONSTRAINT "loan_products_rates_chk" CHECK ("loan_products"."interest_rate" >= 0 and "loan_products"."fee_rate" >= 0 and "loan_products"."penalty_rate" >= 0)
);
--> statement-breakpoint
CREATE TABLE "loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_no" text NOT NULL,
	"application_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_snapshot" jsonb NOT NULL,
	"principal" bigint NOT NULL,
	"total_interest" bigint NOT NULL,
	"fee_amount" bigint NOT NULL,
	"net_proceeds" bigint NOT NULL,
	"release_date" date NOT NULL,
	"first_due_date" date NOT NULL,
	"maturity_date" date NOT NULL,
	"status" "loan_status" DEFAULT 'active' NOT NULL,
	"principal_balance" bigint NOT NULL,
	"interest_balance" bigint NOT NULL,
	"penalty_balance" bigint DEFAULT 0 NOT NULL,
	"total_balance" bigint GENERATED ALWAYS AS (principal_balance + interest_balance + penalty_balance) STORED,
	"days_past_due" integer DEFAULT 0 NOT NULL,
	"released_by" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loans_balances_chk" CHECK ("loans"."principal_balance" >= 0 and "loans"."interest_balance" >= 0 and "loans"."penalty_balance" >= 0),
	CONSTRAINT "loans_amounts_chk" CHECK ("loans"."principal" > 0 and "loans"."net_proceeds" >= 0 and "loans"."fee_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_no" text NOT NULL,
	"first_name" text NOT NULL,
	"middle_name" text,
	"last_name" text NOT NULL,
	"birthdate" date NOT NULL,
	"sex" text NOT NULL,
	"civil_status" text NOT NULL,
	"address" text NOT NULL,
	"mobile" text NOT NULL,
	"email" text,
	"employment" text NOT NULL,
	"gov_id_type" text NOT NULL,
	"gov_id_number" text,
	"gov_id_file_key" text,
	"photo_key" text,
	"status" "member_status" DEFAULT 'pending' NOT NULL,
	"channel" "channel" NOT NULL,
	"consent_version" text,
	"consent_accepted_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_sex_chk" CHECK ("members"."sex" in ('F', 'M')),
	CONSTRAINT "members_mobile_chk" CHECK ("members"."mobile" ~ '^09[0-9]{9}$')
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"channels" text[] DEFAULT '{inbox}'::text[] NOT NULL,
	"installment_id" uuid,
	"trigger" text,
	"sent_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"installment_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"penalty" bigint NOT NULL,
	"interest" bigint NOT NULL,
	"principal" bigint NOT NULL,
	CONSTRAINT "payment_allocations_chk" CHECK ("payment_allocations"."penalty" >= 0 and "payment_allocations"."interest" >= 0 and "payment_allocations"."principal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_no" text NOT NULL,
	"loan_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference_no" text,
	"payment_date" date NOT NULL,
	"advance_amount" bigint DEFAULT 0 NOT NULL,
	"received_by" uuid NOT NULL,
	"status" "payment_status" DEFAULT 'posted' NOT NULL,
	"void_reason" text,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_chk" CHECK ("payments"."amount" > 0),
	CONSTRAINT "payments_void_chk" CHECK (("payments"."status" = 'voided') = ("payments"."void_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "penalty_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installment_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"period_no" integer NOT NULL,
	"amount" bigint NOT NULL,
	"assessed_for_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "penalty_assessments_amount_chk" CHECK ("penalty_assessments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_type" text NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"status" "staff_status" DEFAULT 'active' NOT NULL,
	"totp_secret" text,
	"totp_enabled_at" timestamp with time zone,
	"totp_last_step" bigint,
	"recovery_code_hashes" text[] DEFAULT '{}'::text[] NOT NULL,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_status_history" ADD CONSTRAINT "application_status_history_application_id_loan_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."loan_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installments" ADD CONSTRAINT "installments_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_installment_id_installments_id_fk" FOREIGN KEY ("installment_id") REFERENCES "public"."installments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_penalty_assessment_id_penalty_assessments_id_fk" FOREIGN KEY ("penalty_assessment_id") REFERENCES "public"."penalty_assessments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_product_id_loan_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."loan_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_encoded_by_staff_users_id_fk" FOREIGN KEY ("encoded_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_approved_by_staff_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_application_id_loan_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."loan_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_product_id_loan_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."loan_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_released_by_staff_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_installment_id_installments_id_fk" FOREIGN KEY ("installment_id") REFERENCES "public"."installments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_installment_id_installments_id_fk" FOREIGN KEY ("installment_id") REFERENCES "public"."installments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_received_by_staff_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_voided_by_staff_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "penalty_assessments" ADD CONSTRAINT "penalty_assessments_installment_id_installments_id_fk" FOREIGN KEY ("installment_id") REFERENCES "public"."installments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "penalty_assessments" ADD CONSTRAINT "penalty_assessments_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_status_history_app_idx" ON "application_status_history" USING btree ("application_id","changed_at");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_at_idx" ON "audit_logs" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_actor_key_uq" ON "idempotency_keys" USING btree ("actor_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "installments_loan_seq_uq" ON "installments" USING btree ("loan_id","schedule_version","seq");--> statement-breakpoint
CREATE INDEX "installments_due_status_idx" ON "installments" USING btree ("due_date","status");--> statement-breakpoint
CREATE INDEX "ledger_entries_loan_idx" ON "ledger_entries" USING btree ("loan_id","posted_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_member_idx" ON "ledger_entries" USING btree ("member_id","effective_date");--> statement-breakpoint
CREATE INDEX "ledger_entries_installment_idx" ON "ledger_entries" USING btree ("installment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_reverses_uq" ON "ledger_entries" USING btree ("reverses_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_applications_no_uq" ON "loan_applications" USING btree ("application_no");--> statement-breakpoint
CREATE INDEX "loan_applications_member_status_idx" ON "loan_applications" USING btree ("member_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_products_code_uq" ON "loan_products" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "loans_loan_no_uq" ON "loans" USING btree ("loan_no");--> statement-breakpoint
CREATE UNIQUE INDEX "loans_application_uq" ON "loans" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "loans_member_status_idx" ON "loans" USING btree ("member_id","status");--> statement-breakpoint
CREATE INDEX "loans_status_idx" ON "loans" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "members_member_no_uq" ON "members" USING btree ("member_no");--> statement-breakpoint
CREATE UNIQUE INDEX "members_mobile_uq" ON "members" USING btree ("mobile");--> statement-breakpoint
CREATE INDEX "members_status_idx" ON "members" USING btree ("status");--> statement-breakpoint
CREATE INDEX "members_name_trgm_idx" ON "members" USING gin (("first_name" || ' ' || "last_name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "notifications_member_idx" ON "notifications" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_reminder_uq" ON "notifications" USING btree ("installment_id","trigger") WHERE "notifications"."installment_id" is not null;--> statement-breakpoint
CREATE INDEX "payment_allocations_payment_idx" ON "payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_installment_idx" ON "payment_allocations" USING btree ("installment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_receipt_uq" ON "payments" USING btree ("receipt_no");--> statement-breakpoint
CREATE INDEX "payments_loan_date_idx" ON "payments" USING btree ("loan_id","payment_date");--> statement-breakpoint
CREATE INDEX "payments_date_idx" ON "payments" USING btree ("payment_date");--> statement-breakpoint
CREATE UNIQUE INDEX "penalty_assessments_period_uq" ON "penalty_assessments" USING btree ("installment_id","period_no");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_hash_uq" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_type","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_users_email_uq" ON "staff_users" USING btree (lower("email"));