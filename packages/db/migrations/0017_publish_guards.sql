ALTER TABLE `org_settings` ADD `publish_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `playlists` ADD `row_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `schedule_entries` ADD `row_version` integer DEFAULT 1 NOT NULL;