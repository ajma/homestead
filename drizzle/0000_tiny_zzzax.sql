CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`id_token` text,
	`password` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `apps` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`description` text,
	`icon_ref` text,
	`category` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`show_on_launcher` integer DEFAULT true NOT NULL,
	`directory` text NOT NULL,
	`compose_file` text NOT NULL,
	`project_name` text NOT NULL,
	`launch_internal_url` text,
	`last_compose_hash` text,
	`is_system` integer DEFAULT false NOT NULL,
	`grace_until` integer,
	`adopted_at` integer DEFAULT (unixepoch()) NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `apps_launcher_idx` ON `apps` (`show_on_launcher`,`category`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `apps_host_slug` ON `apps` (`host_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `apps_host_directory` ON `apps` (`host_id`,`directory`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`auth_path` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`detail` text,
	`ip` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_created_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `check_results` (
	`id` text PRIMARY KEY NOT NULL,
	`probe_id` text NOT NULL,
	`status` text NOT NULL,
	`fault_class` text,
	`latency_ms` integer,
	`detail` text,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`probe_id`) REFERENCES `probes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `check_results_probe_time_idx` ON `check_results` (`probe_id`,`checked_at`);--> statement-breakpoint
CREATE TABLE `check_rollups` (
	`probe_id` text NOT NULL,
	`hour_start` integer NOT NULL,
	`up_count` integer DEFAULT 0 NOT NULL,
	`degraded_count` integer DEFAULT 0 NOT NULL,
	`down_count` integer DEFAULT 0 NOT NULL,
	`avg_latency_ms` integer,
	`max_latency_ms` integer,
	PRIMARY KEY(`probe_id`, `hour_start`),
	FOREIGN KEY (`probe_id`) REFERENCES `probes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `exposures` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`hostname` text NOT NULL,
	`zone_id` text,
	`dns_record_id` text,
	`tunnel_id` text,
	`ingress_service` text NOT NULL,
	`access_app_id` text,
	`access_app_aud` text,
	`dns_record_created_by_us` integer DEFAULT false NOT NULL,
	`ingress_rule_created_by_us` integer DEFAULT false NOT NULL,
	`access_app_created_by_us` integer DEFAULT false NOT NULL,
	`state` text DEFAULT 'provisioning' NOT NULL,
	`last_error` text,
	`last_synced_at` integer,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exposures_app_id_unique` ON `exposures` (`app_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `exposures_hostname_unique` ON `exposures` (`hostname`);--> statement-breakpoint
CREATE TABLE `hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'local' NOT NULL,
	`compose_root` text NOT NULL,
	`docker_socket` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `image_status` (
	`app_id` text NOT NULL,
	`service_name` text NOT NULL,
	`current_digest` text,
	`latest_digest` text,
	`update_available` integer DEFAULT false NOT NULL,
	`checked_at` integer,
	PRIMARY KEY(`app_id`, `service_name`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`exit_code` integer,
	`output` text,
	`user_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `jobs_app_created_idx` ON `jobs` (`app_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `probes` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text,
	`target` text,
	`expected_status_pattern` text DEFAULT '2xx,3xx' NOT NULL,
	`timeout_ms` integer DEFAULT 5000 NOT NULL,
	`interval_seconds` integer DEFAULT 60 NOT NULL,
	`insecure_tls` integer DEFAULT false NOT NULL,
	`follow_redirects` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` integer DEFAULT 0 NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_status` text DEFAULT 'unknown' NOT NULL,
	`last_latency_ms` integer,
	`last_detail` text,
	`last_fault_class` text,
	`last_checked_at` integer,
	`status_since` integer,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `probes_due_idx` ON `probes` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `probes_app_idx` ON `probes` (`app_id`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`key` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`tag` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `setup_state` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`completed_steps` text DEFAULT '[]' NOT NULL,
	`completed_at` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_app_scope` (
	`user_id` text NOT NULL,
	`app_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `app_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`role` text DEFAULT 'viewer' NOT NULL,
	`scope_all_apps` integer DEFAULT true NOT NULL,
	`disabled_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
