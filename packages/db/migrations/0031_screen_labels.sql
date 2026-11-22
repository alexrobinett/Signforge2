CREATE TABLE `screen_labels` (
	`org_id` text NOT NULL,
	`screen_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `screen_id`, `key`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`screen_id`) REFERENCES `screens`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `screen_labels_key_value_idx` ON `screen_labels` (`org_id`,`key`,`value`);