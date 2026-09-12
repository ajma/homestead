ALTER TABLE `apps` ADD `system_kind` text;--> statement-breakpoint
UPDATE `apps` SET `system_kind` = 'self' WHERE `is_system` = 1;
