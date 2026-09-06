ALTER TABLE `account` ADD `issuer` text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `account_issuer_accountId_unique` ON `account` (`issuer`,`account_id`);