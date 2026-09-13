ALTER TABLE `exposures` ADD `probe_id` text;--> statement-breakpoint
ALTER TABLE `exposures` ADD `probe_created_by_us` integer DEFAULT false NOT NULL;