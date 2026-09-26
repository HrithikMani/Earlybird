CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text,
	`rule_id` text,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`message` text NOT NULL,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `alerts_company_idx` ON `alerts` (`company_id`,`kind`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`careers_url` text NOT NULL,
	`status` text NOT NULL,
	`role_mode` text DEFAULT 'global_plus_company' NOT NULL,
	`active_rule_id` text,
	`fallback_rule_id` text,
	`using_fallback` integer DEFAULT false NOT NULL,
	`interval_min` integer,
	`effective_interval_min` integer,
	`source_filters` text,
	`notify_filters` text,
	`discord_channel_id` text,
	`last_run_at` integer,
	`next_run_at` integer,
	`last_success_at` integer,
	`last_full_sweep_at` integer,
	`last_new_job_at` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`consecutive_zero_runs` integer DEFAULT 0 NOT NULL,
	`last_job_count` integer,
	`last_full_job_count` integer,
	`health_note` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `company_terms` (
	`company_id` text NOT NULL,
	`term` text NOT NULL,
	`baselined_at` integer NOT NULL,
	PRIMARY KEY(`company_id`, `term`)
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`rule_id` text,
	`job_key` text NOT NULL,
	`external_id` text,
	`canonical_url` text NOT NULL,
	`fingerprint` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`location` text,
	`department` text,
	`posted_at` integer,
	`posted_at_raw` text,
	`matched_roles` text,
	`search_term` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`seen_count` integer DEFAULT 1 NOT NULL,
	`missing_sweeps` integer DEFAULT 0 NOT NULL,
	`closed_at` integer,
	`notify_status` text NOT NULL,
	`notify_skip_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_company_key_uq` ON `jobs` (`company_id`,`job_key`);--> statement-breakpoint
CREATE INDEX `jobs_first_seen_idx` ON `jobs` (`first_seen_at`);--> statement-breakpoint
CREATE INDEX `jobs_rule_idx` ON `jobs` (`rule_id`);--> statement-breakpoint
CREATE TABLE `logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`level` text NOT NULL,
	`msg` text,
	`scope` text,
	`company_id` text,
	`rule_id` text,
	`run_id` text,
	`task_id` text,
	`data` text
);
--> statement-breakpoint
CREATE INDEX `logs_ts_idx` ON `logs` (`ts`);--> statement-breakpoint
CREATE INDEX `logs_run_idx` ON `logs` (`run_id`);--> statement-breakpoint
CREATE INDEX `logs_task_idx` ON `logs` (`task_id`);--> statement-breakpoint
CREATE INDEX `logs_company_idx` ON `logs` (`company_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`job_key` text NOT NULL,
	`job_id` text,
	`channel_id` text NOT NULL,
	`kind` text DEFAULT 'job' NOT NULL,
	`status` text NOT NULL,
	`discord_message_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notif_uq` ON `notifications` (`company_id`,`job_key`,`channel_id`,`kind`);--> statement-breakpoint
CREATE INDEX `notif_status_idx` ON `notifications` (`status`);--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`scope` text NOT NULL,
	`company_id` text,
	`search_terms` text NOT NULL,
	`synonyms` text NOT NULL,
	`exclude_words` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`notify_existing` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `roles_company_idx` ON `roles` (`company_id`);--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_key` text NOT NULL,
	`version` integer NOT NULL,
	`company_id` text NOT NULL,
	`slot` text NOT NULL,
	`type` text NOT NULL,
	`strategy` text NOT NULL,
	`spec` text NOT NULL,
	`code` text,
	`code_hash` text,
	`approved_at` integer,
	`score` text,
	`source_task_id` text,
	`created_by` text NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rules_company_idx` ON `rules` (`company_id`);--> statement-breakpoint
CREATE INDEX `rules_key_idx` ON `rules` (`rule_key`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`rule_id` text,
	`mode` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`duration_ms` integer,
	`http_status` integer,
	`job_count` integer,
	`new_job_count` integer,
	`notified_count` integer,
	`closed_job_count` integer,
	`stats` text,
	`error_type` text,
	`error_message` text,
	`error_detail` text,
	`artifacts` text
);
--> statement-breakpoint
CREATE INDEX `runs_company_idx` ON `runs` (`company_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `runs_rule_idx` ON `runs` (`rule_id`);--> statement-breakpoint
CREATE TABLE `seen_jobs` (
	`company_id` text NOT NULL,
	`job_key` text NOT NULL,
	`external_id` text,
	`canonical_url` text NOT NULL,
	`fingerprint` text NOT NULL,
	`aliases` text,
	`title` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`first_rule_id` text,
	`notified_at` integer,
	PRIMARY KEY(`company_id`, `job_key`)
);
--> statement-breakpoint
CREATE INDEX `seen_url_idx` ON `seen_jobs` (`company_id`,`canonical_url`);--> statement-breakpoint
CREATE INDEX `seen_fp_idx` ON `seen_jobs` (`company_id`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`ts` integer NOT NULL,
	`seq` integer NOT NULL,
	`level` text NOT NULL,
	`type` text NOT NULL,
	`data` text
);
--> statement-breakpoint
CREATE INDEX `task_events_task_idx` ON `task_events` (`task_id`,`seq`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`company_id` text,
	`rule_id` text,
	`parent_task_id` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`input` text,
	`result` text,
	`error_type` text,
	`error_message` text,
	`model` text,
	`prompt_file` text,
	`prompt_hash` text,
	`steps` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`operator_note` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `tasks_company_idx` ON `tasks` (`company_id`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`company_id` text NOT NULL,
	`task_id` text,
	`source` text DEFAULT 'app' NOT NULL,
	`window` text NOT NULL,
	`verdict` text NOT NULL,
	`report` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verif_rule_idx` ON `verifications` (`rule_id`);