DROP INDEX `blob_deletes_due_idx`;--> statement-breakpoint
ALTER TABLE `blob_deletes` ADD `deleted_at` integer;--> statement-breakpoint
CREATE INDEX `blob_deletes_tombstone_idx` ON `blob_deletes` (`org_id`,`deleted_at`) WHERE deleted_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX `blob_deletes_due_idx` ON `blob_deletes` (`org_id`,`queued_at`,`claim_until`) WHERE deleted_at IS NULL;