CREATE TABLE `feed_image_deletes` (
	`org_id` text NOT NULL,
	`sha256` text NOT NULL,
	`queued_at` integer NOT NULL,
	`deleting_until` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`org_id`, `sha256`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `feed_images` (
	`org_id` text NOT NULL,
	`url` text NOT NULL,
	`source_id` text NOT NULL,
	`source_sha256` text,
	`file_sha256` text,
	`thumb_sha256` text,
	`etag` text,
	`last_modified` text,
	`next_check_at` integer NOT NULL,
	`last_error` text,
	`failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `url`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `feed_images_org_source_sha_idx` ON `feed_images` (`org_id`,`source_sha256`);--> statement-breakpoint
ALTER TABLE `data_sources` ADD `photos` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `data_sources` ADD `photo_urls_json` text;