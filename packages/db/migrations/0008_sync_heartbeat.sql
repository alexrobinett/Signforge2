ALTER TABLE `screens` ADD `heartbeat_json` text;--> statement-breakpoint
ALTER TABLE `screens` ADD `sync_epoch` text;--> statement-breakpoint
ALTER TABLE `screens` ADD `sync_ack_seq` integer DEFAULT 0 NOT NULL;