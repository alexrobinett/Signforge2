CREATE TABLE `publish_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`requested_by_kind` text NOT NULL,
	`requested_by` text NOT NULL,
	`client_id` text,
	`drafts_json` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`publish_id` text,
	`row_version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publish_requests_org_id_uq` ON `publish_requests` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `publish_requests_org_created_idx` ON `publish_requests` (`org_id`,`created_at`);