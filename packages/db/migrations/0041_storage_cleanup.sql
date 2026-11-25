CREATE TABLE `blob_deletes` (
	`org_id` text NOT NULL,
	`sha256` text NOT NULL,
	`queued_at` integer NOT NULL,
	`claim_owner` text,
	`claim_until` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`org_id`, `sha256`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `storage_sweeps` (
	`org_id` text PRIMARY KEY NOT NULL,
	`owner` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`swept_at` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `stored_manifests` (
	`org_id` text NOT NULL,
	`manifest_id` text NOT NULL,
	`files_json` text NOT NULL,
	`stored_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `manifest_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
