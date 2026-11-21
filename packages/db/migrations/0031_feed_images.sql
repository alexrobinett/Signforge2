CREATE TABLE `feed_images` (
	`org_id` text NOT NULL,
	`url` text NOT NULL,
	`source_id` text NOT NULL,
	`source_sha256` text,
	`file_sha256` text,
	`sample_sha256` text,
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
ALTER TABLE `data_sources` ADD `photos` integer DEFAULT true NOT NULL;