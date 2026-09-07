CREATE TABLE `check_rollups` (
	`monitor_id` text NOT NULL,
	`hour_started_at` integer NOT NULL,
	`up_count` integer NOT NULL,
	`down_count` integer NOT NULL,
	PRIMARY KEY(`monitor_id`, `hour_started_at`)
);
--> statement-breakpoint
CREATE TABLE `checks` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`at` integer NOT NULL,
	`up` integer NOT NULL,
	`duration_ms` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `checks_monitor_at_idx` ON `checks` (`monitor_id`,`at`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`tailscale_node_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`notes` text,
	`hidden` integer DEFAULT false NOT NULL,
	`last_synced_at` integer,
	`hostname` text,
	`os` text,
	`addresses` text,
	`user` text,
	`client_version` text,
	`update_available` integer,
	`tags` text,
	`is_ephemeral` integer,
	`is_external` integer,
	`blocks_incoming_connections` integer,
	`connected_to_control` integer,
	`last_seen` integer
);
--> statement-breakpoint
CREATE TABLE `monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`interval_seconds` integer NOT NULL,
	`timeout_ms` integer NOT NULL,
	`retries` integer DEFAULT 0 NOT NULL,
	`required` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_due_at` integer DEFAULT 0 NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `monitors_due_idx` ON `monitors` (`enabled`,`next_due_at`);--> statement-breakpoint
CREATE INDEX `monitors_target_idx` ON `monitors` (`target_type`,`target_id`);