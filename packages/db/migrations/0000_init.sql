CREATE TABLE `asset_renditions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`orientation` text NOT NULL,
	`sha256` text NOT NULL,
	`type` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`,`asset_id`) REFERENCES `assets`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_renditions_org_id_uq` ON `asset_renditions` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `asset_renditions_asset_orientation_uq` ON `asset_renditions` (`org_id`,`asset_id`,`orientation`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`sha256` text NOT NULL,
	`type` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer,
	`height` integer,
	`duration_ms` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_org_id_uq` ON `assets` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `assets_org_sha_idx` ON `assets` (`org_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`at` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`target_kind` text,
	`target_id` text,
	`detail_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_log_org_id_uq` ON `audit_log` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `audit_log_org_at_idx` ON `audit_log` (`org_id`,`at`);--> statement-breakpoint
CREATE TABLE `data_snapshots` (
	`org_id` text NOT NULL,
	`data_source_id` text NOT NULL,
	`version` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`data_json` text NOT NULL,
	PRIMARY KEY(`org_id`, `data_source_id`),
	FOREIGN KEY (`org_id`,`data_source_id`) REFERENCES `data_sources`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `data_sources` (
	`id` text PRIMARY KEY NOT NULL,
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
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `data_sources_org_id_uq` ON `data_sources` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `pairing_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`poll_token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`claimed_org_id` text,
	`claimed_screen_id` text,
	`claimed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`claimed_org_id`,`claimed_screen_id`) REFERENCES `screens`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pairing_codes_code_uq` ON `pairing_codes` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `pairing_codes_poll_token_uq` ON `pairing_codes` (`poll_token_hash`);--> statement-breakpoint
CREATE TABLE `play_counts` (
	`org_id` text NOT NULL,
	`screen_id` text NOT NULL,
	`hour` integer NOT NULL,
	`spot_id` text NOT NULL,
	`plays` integer DEFAULT 0 NOT NULL,
	`ms` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`org_id`, `screen_id`, `hour`, `spot_id`),
	FOREIGN KEY (`org_id`,`screen_id`) REFERENCES `screens`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `play_counts_org_hour_idx` ON `play_counts` (`org_id`,`hour`);--> statement-breakpoint
CREATE TABLE `playlist_items` (
	`org_id` text NOT NULL,
	`playlist_id` text NOT NULL,
	`position` integer NOT NULL,
	`spot_id` text NOT NULL,
	PRIMARY KEY(`org_id`, `playlist_id`, `position`),
	FOREIGN KEY (`org_id`,`playlist_id`) REFERENCES `playlists`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`spot_id`) REFERENCES `spots`(`org_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `playlist_items_spot_idx` ON `playlist_items` (`org_id`,`spot_id`);--> statement-breakpoint
CREATE TABLE `playlists` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`transition_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `playlists_org_id_uq` ON `playlists` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `publish_screens` (
	`org_id` text NOT NULL,
	`publish_id` text NOT NULL,
	`screen_id` text NOT NULL,
	`manifest_id` text NOT NULL,
	PRIMARY KEY(`org_id`, `publish_id`, `screen_id`),
	FOREIGN KEY (`org_id`,`publish_id`) REFERENCES `publishes`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`screen_id`) REFERENCES `screens`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `publish_screens_screen_idx` ON `publish_screens` (`org_id`,`screen_id`);--> statement-breakpoint
CREATE TABLE `publishes` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`status` text NOT NULL,
	`publish_at` integer,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publishes_org_id_uq` ON `publishes` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `publishes_org_created_idx` ON `publishes` (`org_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `schedule_entries` (
	`id` text PRIMARY KEY NOT NULL,
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
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`,`playlist_id`) REFERENCES `playlists`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`group_id`) REFERENCES `screen_groups`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`screen_id`) REFERENCES `screens`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "schedule_entries_target_ck" CHECK(("schedule_entries"."target" = 'org' AND "schedule_entries"."group_id" IS NULL AND "schedule_entries"."screen_id" IS NULL)
        OR ("schedule_entries"."target" = 'group' AND "schedule_entries"."group_id" IS NOT NULL AND "schedule_entries"."screen_id" IS NULL)
        OR ("schedule_entries"."target" = 'screen' AND "schedule_entries"."screen_id" IS NOT NULL AND "schedule_entries"."group_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_entries_org_id_uq` ON `schedule_entries` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `schedule_entries_org_playlist_idx` ON `schedule_entries` (`org_id`,`playlist_id`);--> statement-breakpoint
CREATE TABLE `screen_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`screen_id` text NOT NULL,
	`secret_hash` text NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`,`screen_id`) REFERENCES `screens`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `screen_credentials_org_id_uq` ON `screen_credentials` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `screen_credentials_screen_idx` ON `screen_credentials` (`org_id`,`screen_id`);--> statement-breakpoint
CREATE TABLE `screen_group_members` (
	`org_id` text NOT NULL,
	`group_id` text NOT NULL,
	`screen_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `group_id`, `screen_id`),
	FOREIGN KEY (`org_id`,`group_id`) REFERENCES `screen_groups`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`screen_id`) REFERENCES `screens`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `screen_group_members_screen_idx` ON `screen_group_members` (`org_id`,`screen_id`);--> statement-breakpoint
CREATE TABLE `screen_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `screen_groups_org_id_uq` ON `screen_groups` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `screens` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`timezone` text NOT NULL,
	`locale` text,
	`orientation` text NOT NULL,
	`display_hours_json` text,
	`desired_manifest_id` text,
	`reported_manifest_id` text,
	`last_seen_at` integer,
	`player_version` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `screens_org_id_uq` ON `screens` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `screens_org_name_idx` ON `screens` (`org_id`,`name`);--> statement-breakpoint
CREATE TABLE `spots` (
	`id` text PRIMARY KEY NOT NULL,
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
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`template_version_id`) REFERENCES `template_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`asset_id`) REFERENCES `assets`(`org_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spots_org_id_uq` ON `spots` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `spots_org_asset_idx` ON `spots` (`org_id`,`asset_id`);--> statement-breakpoint
CREATE TABLE `template_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`template_id` text NOT NULL,
	`version` text NOT NULL,
	`manifest_json` text NOT NULL,
	`bundle_sha256` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`check_report_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`,`template_id`) REFERENCES `templates`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `template_versions_org_id_uq` ON `template_versions` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `template_versions_org_version_uq` ON `template_versions` (`org_id`,`template_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `template_versions_base_version_uq` ON `template_versions` (`template_id`,`version`) WHERE "template_versions"."org_id" IS NULL;--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `templates_org_id_uq` ON `templates` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `templates_org_key_uq` ON `templates` (`org_id`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `templates_base_key_uq` ON `templates` (`key`) WHERE "templates"."org_id" IS NULL;