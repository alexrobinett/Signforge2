CREATE INDEX `feed_images_org_file_sha_idx` ON `feed_images` (`org_id`,`file_sha256`);--> statement-breakpoint
CREATE INDEX `feed_images_org_thumb_sha_idx` ON `feed_images` (`org_id`,`thumb_sha256`);