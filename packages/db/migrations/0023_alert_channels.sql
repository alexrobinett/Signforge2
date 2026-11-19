CREATE TABLE `alert_channels` (
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`host` text NOT NULL,
	`url_encrypted` text NOT NULL,
	`secret_encrypted` text,
	`secret_set_at` integer,
	`connected_by` text NOT NULL,
	`row_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `kind`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `alert_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`channel` text NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`event_json` text NOT NULL,
	`to_user_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`give_up_at` integer NOT NULL,
	`last_attempt_at` integer,
	`leased_until` integer,
	`last_http_status` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_deliveries_org_id_uq` ON `alert_deliveries` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `alert_deliveries_event_uq` ON `alert_deliveries` (`org_id`,`event_id`,`channel`);--> statement-breakpoint
CREATE INDEX `alert_deliveries_org_created_idx` ON `alert_deliveries` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `alert_deliveries_due_idx` ON `alert_deliveries` (`next_attempt_at`) WHERE "alert_deliveries"."status" = 'pending';