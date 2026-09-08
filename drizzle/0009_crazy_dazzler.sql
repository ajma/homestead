CREATE TABLE `project_identity` (
	`slug` text PRIMARY KEY NOT NULL,
	`display_name` text,
	`description` text,
	`icon_slug` text,
	`icon_url` text,
	`updated_at` integer NOT NULL
);
