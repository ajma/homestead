CREATE TABLE `exposures` (
	`id` text PRIMARY KEY NOT NULL,
	`project_slug` text,
	`host_port` integer NOT NULL,
	`zone_id` text NOT NULL,
	`hostname` text NOT NULL,
	`scheme` text DEFAULT 'http' NOT NULL,
	`no_tls_verify` integer DEFAULT false NOT NULL,
	`label` text,
	`enabled` integer DEFAULT true NOT NULL,
	`access_enabled` integer DEFAULT true NOT NULL,
	`access_app_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exposures_hostname_unique` ON `exposures` (`hostname`);--> statement-breakpoint
CREATE INDEX `exposures_port_idx` ON `exposures` (`host_port`);