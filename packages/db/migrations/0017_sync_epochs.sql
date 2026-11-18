CREATE TABLE `sync_epochs` (
	`org_id` text NOT NULL,
	`screen_id` text NOT NULL,
	`epoch` text NOT NULL,
	`ack_seq` integer NOT NULL,
	PRIMARY KEY(`org_id`, `screen_id`, `epoch`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`screen_id`) REFERENCES `screens`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Each screen's current epoch keeps its mark; the epochs before it were never kept.
INSERT INTO `sync_epochs` (`org_id`, `screen_id`, `epoch`, `ack_seq`) SELECT `org_id`, `id`, `sync_epoch`, `sync_ack_seq` FROM `screens` WHERE `sync_epoch` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `screens` DROP COLUMN `sync_epoch`;--> statement-breakpoint
ALTER TABLE `screens` DROP COLUMN `sync_ack_seq`;
