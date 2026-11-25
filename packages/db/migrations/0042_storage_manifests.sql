ALTER TABLE `storage_sweeps` ADD `manifests_checked_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `stored_manifests` ADD `claim_owner` text;--> statement-breakpoint
ALTER TABLE `stored_manifests` ADD `claim_until` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `stored_manifests` ADD `deleted_at` integer;