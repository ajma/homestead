ALTER TABLE `exposures` ADD `probe_internal_id` text;--> statement-breakpoint
ALTER TABLE `exposures` ADD `probe_internal_created_by_us` integer DEFAULT false NOT NULL;