CREATE TABLE `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_slug` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`exit_code` integer,
	`actor_user_id` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`output` text DEFAULT '' NOT NULL
);
