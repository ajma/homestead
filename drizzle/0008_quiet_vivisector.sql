CREATE TABLE `manual_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`icon_slug` text,
	`icon_url` text,
	`hidden` integer DEFAULT false NOT NULL
);
