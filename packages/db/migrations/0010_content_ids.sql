-- Review fix 4: content tables keyed (org_id, id), so two orgs may use the same content id.
-- Rebuilds spots, playlists, schedule_entries and data_sources (SQLite cannot change a primary key).
--
-- D1 cannot turn foreign keys off, and dropping a table runs an implicit DELETE whose ON DELETE
-- CASCADE actions still fire: playlist_items and data_snapshots would lose their rows. So both
-- are copied aside first and put back once the new tables are in place (without this the rebuild
-- fails on local D1; with it every row survives and PRAGMA foreign_key_check is clean). Deferred
-- checks let the parents be dropped and renamed while children point at them; all is checked at commit.
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__keep_playlist_items` AS SELECT * FROM `playlist_items`;--> statement-breakpoint
CREATE TABLE `__keep_data_snapshots` AS SELECT * FROM `data_snapshots`;--> statement-breakpoint
CREATE TABLE `__new_data_sources` (
	`id` text NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`format` text NOT NULL,
	`url_encrypted` text NOT NULL,
	`refresh_s` integer NOT NULL,
	`next_poll_at` integer DEFAULT 0 NOT NULL,
	`etag` text,
	`last_modified` text,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `id`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_data_sources`("id", "org_id", "name", "format", "url_encrypted", "refresh_s", "next_poll_at", "etag", "last_modified", "failures", "last_error", "created_at", "updated_at") SELECT "id", "org_id", "name", "format", "url_encrypted", "refresh_s", "next_poll_at", "etag", "last_modified", "failures", "last_error", "created_at", "updated_at" FROM `data_sources`;--> statement-breakpoint
DROP TABLE `data_sources`;--> statement-breakpoint
ALTER TABLE `__new_data_sources` RENAME TO `data_sources`;--> statement-breakpoint
CREATE TABLE `__new_playlists` (
	`id` text NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`transition_json` text NOT NULL,
	`published_json` text,
	`published_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `id`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_playlists`("id", "org_id", "name", "transition_json", "published_json", "published_at", "created_at", "updated_at") SELECT "id", "org_id", "name", "transition_json", "published_json", "published_at", "created_at", "updated_at" FROM `playlists`;--> statement-breakpoint
DROP TABLE `playlists`;--> statement-breakpoint
ALTER TABLE `__new_playlists` RENAME TO `playlists`;--> statement-breakpoint
CREATE TABLE `__new_schedule_entries` (
	`id` text NOT NULL,
	`org_id` text NOT NULL,
	`playlist_id` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`target` text NOT NULL,
	`group_id` text,
	`screen_id` text,
	`start_date` text,
	`end_date` text,
	`days_json` text,
	`from_time` text,
	`to_time` text,
	`published_json` text,
	`published_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `id`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`playlist_id`) REFERENCES `playlists`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`group_id`) REFERENCES `screen_groups`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`screen_id`) REFERENCES `screens`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "schedule_entries_target_ck" CHECK(("target" = 'org' AND "group_id" IS NULL AND "screen_id" IS NULL)
        OR ("target" = 'group' AND "group_id" IS NOT NULL AND "screen_id" IS NULL)
        OR ("target" = 'screen' AND "screen_id" IS NOT NULL AND "group_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_schedule_entries`("id", "org_id", "playlist_id", "priority", "target", "group_id", "screen_id", "start_date", "end_date", "days_json", "from_time", "to_time", "published_json", "published_at", "created_at", "updated_at") SELECT "id", "org_id", "playlist_id", "priority", "target", "group_id", "screen_id", "start_date", "end_date", "days_json", "from_time", "to_time", "published_json", "published_at", "created_at", "updated_at" FROM `schedule_entries`;--> statement-breakpoint
DROP TABLE `schedule_entries`;--> statement-breakpoint
ALTER TABLE `__new_schedule_entries` RENAME TO `schedule_entries`;--> statement-breakpoint
CREATE INDEX `schedule_entries_org_playlist_idx` ON `schedule_entries` (`org_id`,`playlist_id`);--> statement-breakpoint
CREATE TABLE `__new_spots` (
	`id` text NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`template_version_id` text,
	`data_json` text,
	`asset_map_json` text,
	`bindings_json` text,
	`asset_id` text,
	`fit` text,
	`url` text,
	`published_json` text,
	`published_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `id`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_version_id`) REFERENCES `template_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`asset_id`) REFERENCES `assets`(`org_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_spots`("id", "org_id", "name", "kind", "duration_ms", "template_version_id", "data_json", "asset_map_json", "bindings_json", "asset_id", "fit", "url", "published_json", "published_at", "created_at", "updated_at") SELECT "id", "org_id", "name", "kind", "duration_ms", "template_version_id", "data_json", "asset_map_json", "bindings_json", "asset_id", "fit", "url", "published_json", "published_at", "created_at", "updated_at" FROM `spots`;--> statement-breakpoint
DROP TABLE `spots`;--> statement-breakpoint
ALTER TABLE `__new_spots` RENAME TO `spots`;--> statement-breakpoint
CREATE INDEX `spots_org_asset_idx` ON `spots` (`org_id`,`asset_id`);--> statement-breakpoint
DELETE FROM `playlist_items`;--> statement-breakpoint
INSERT INTO `playlist_items` (`org_id`, `playlist_id`, `position`, `spot_id`) SELECT `org_id`, `playlist_id`, `position`, `spot_id` FROM `__keep_playlist_items`;--> statement-breakpoint
DELETE FROM `data_snapshots`;--> statement-breakpoint
INSERT INTO `data_snapshots` (`org_id`, `data_source_id`, `version`, `fetched_at`, `data_json`) SELECT `org_id`, `data_source_id`, `version`, `fetched_at`, `data_json` FROM `__keep_data_snapshots`;--> statement-breakpoint
DROP TABLE `__keep_playlist_items`;--> statement-breakpoint
DROP TABLE `__keep_data_snapshots`;--> statement-breakpoint
PRAGMA defer_foreign_keys = off;
