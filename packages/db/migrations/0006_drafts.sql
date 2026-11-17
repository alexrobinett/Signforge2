CREATE TABLE `org_settings` (
	`org_id` text PRIMARY KEY NOT NULL,
	`default_playlist_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`default_playlist_id`) REFERENCES `playlists`(`org_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `playlists` ADD `published_json` text;--> statement-breakpoint
ALTER TABLE `playlists` ADD `published_at` integer;--> statement-breakpoint
ALTER TABLE `schedule_entries` ADD `published_json` text;--> statement-breakpoint
ALTER TABLE `schedule_entries` ADD `published_at` integer;--> statement-breakpoint
ALTER TABLE `spots` ADD `published_json` text;--> statement-breakpoint
ALTER TABLE `spots` ADD `published_at` integer;