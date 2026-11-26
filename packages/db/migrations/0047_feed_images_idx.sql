CREATE INDEX `feed_images_org_file_sha_idx` ON `feed_images` (`org_id`,`file_sha256`);--> statement-breakpoint
CREATE INDEX `feed_images_org_thumb_sha_idx` ON `feed_images` (`org_id`,`thumb_sha256`);--> statement-breakpoint
CREATE INDEX `feed_images_org_created_idx` ON `feed_images` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `feed_images_next_check_idx` ON `feed_images` (`next_check_at`);