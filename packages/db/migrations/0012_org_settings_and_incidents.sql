CREATE TABLE `screen_incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`screen_id` text NOT NULL,
	`kind` text NOT NULL,
	`last_seen_at` integer NOT NULL,
	`opened_at` integer NOT NULL,
	`cleared_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`screen_id`) REFERENCES `screens`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `screen_incidents_org_id_uq` ON `screen_incidents` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `screen_incidents_open_uq` ON `screen_incidents` (`org_id`,`screen_id`,`kind`) WHERE "screen_incidents"."cleared_at" IS NULL;--> statement-breakpoint
ALTER TABLE `org_settings` ADD `timezone` text;--> statement-breakpoint
ALTER TABLE `org_settings` ADD `locale` text;--> statement-breakpoint
ALTER TABLE `org_settings` ADD `display_hours_json` text;--> statement-breakpoint
ALTER TABLE `org_settings` ADD `update_window_json` text;--> statement-breakpoint
ALTER TABLE `org_settings` ADD `unreachable_after_ms` integer;--> statement-breakpoint
ALTER TABLE `org_settings` ADD `alerts_json` text;