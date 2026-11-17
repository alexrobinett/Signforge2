CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`userId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` date,
	`refreshTokenExpiresAt` date,
	`scope` text,
	`password` text,
	`createdAt` date NOT NULL,
	`updatedAt` date NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`userId`);--> statement-breakpoint
CREATE TABLE `invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text NOT NULL,
	`expiresAt` date NOT NULL,
	`createdAt` date NOT NULL,
	`inviterId` text NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviterId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invitation_organizationId_idx` ON `invitation` (`organizationId`);--> statement-breakpoint
CREATE INDEX `invitation_email_idx` ON `invitation` (`email`);--> statement-breakpoint
CREATE TABLE `member` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`userId` text NOT NULL,
	`role` text NOT NULL,
	`createdAt` date NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_organizationId_idx` ON `member` (`organizationId`);--> statement-breakpoint
CREATE INDEX `member_userId_idx` ON `member` (`userId`);--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo` text,
	`createdAt` date NOT NULL,
	`metadata` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_unique` ON `organization` (`slug`);--> statement-breakpoint
CREATE TABLE `rateLimit` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`lastRequest` bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rateLimit_key_unique` ON `rateLimit` (`key`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` date NOT NULL,
	`token` text NOT NULL,
	`createdAt` date NOT NULL,
	`updatedAt` date NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`userId` text NOT NULL,
	`activeOrganizationId` text,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`userId`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer NOT NULL,
	`image` text,
	`createdAt` date NOT NULL,
	`updatedAt` date NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` date NOT NULL,
	`createdAt` date NOT NULL,
	`updatedAt` date NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_asset_renditions` (
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
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`asset_id`) REFERENCES `assets`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_asset_renditions`("id", "org_id", "asset_id", "orientation", "sha256", "type", "size", "width", "height", "created_at") SELECT "id", "org_id", "asset_id", "orientation", "sha256", "type", "size", "width", "height", "created_at" FROM `asset_renditions`;--> statement-breakpoint
DROP TABLE `asset_renditions`;--> statement-breakpoint
ALTER TABLE `__new_asset_renditions` RENAME TO `asset_renditions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `asset_renditions_org_id_uq` ON `asset_renditions` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `asset_renditions_asset_orientation_uq` ON `asset_renditions` (`org_id`,`asset_id`,`orientation`);--> statement-breakpoint
CREATE TABLE `__new_assets` (
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
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_assets`("id", "org_id", "kind", "name", "sha256", "type", "size", "width", "height", "duration_ms", "status", "created_at", "updated_at") SELECT "id", "org_id", "kind", "name", "sha256", "type", "size", "width", "height", "duration_ms", "status", "created_at", "updated_at" FROM `assets`;--> statement-breakpoint
DROP TABLE `assets`;--> statement-breakpoint
ALTER TABLE `__new_assets` RENAME TO `assets`;--> statement-breakpoint
CREATE UNIQUE INDEX `assets_org_id_uq` ON `assets` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `assets_org_sha_idx` ON `assets` (`org_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `__new_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`at` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`target_kind` text,
	`target_id` text,
	`detail_json` text,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_audit_log`("id", "org_id", "at", "actor_kind", "actor_id", "action", "target_kind", "target_id", "detail_json") SELECT "id", "org_id", "at", "actor_kind", "actor_id", "action", "target_kind", "target_id", "detail_json" FROM `audit_log`;--> statement-breakpoint
DROP TABLE `audit_log`;--> statement-breakpoint
ALTER TABLE `__new_audit_log` RENAME TO `audit_log`;--> statement-breakpoint
CREATE UNIQUE INDEX `audit_log_org_id_uq` ON `audit_log` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `audit_log_org_at_idx` ON `audit_log` (`org_id`,`at`);--> statement-breakpoint
CREATE TABLE `__new_data_snapshots` (
	`org_id` text NOT NULL,
	`data_source_id` text NOT NULL,
	`version` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`data_json` text NOT NULL,
	PRIMARY KEY(`org_id`, `data_source_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`data_source_id`) REFERENCES `data_sources`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_data_snapshots`("org_id", "data_source_id", "version", "fetched_at", "data_json") SELECT "org_id", "data_source_id", "version", "fetched_at", "data_json" FROM `data_snapshots`;--> statement-breakpoint
DROP TABLE `data_snapshots`;--> statement-breakpoint
ALTER TABLE `__new_data_snapshots` RENAME TO `data_snapshots`;--> statement-breakpoint
CREATE TABLE `__new_data_sources` (
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
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_data_sources`("id", "org_id", "name", "format", "url_encrypted", "refresh_s", "next_poll_at", "etag", "last_modified", "failures", "last_error", "created_at", "updated_at") SELECT "id", "org_id", "name", "format", "url_encrypted", "refresh_s", "next_poll_at", "etag", "last_modified", "failures", "last_error", "created_at", "updated_at" FROM `data_sources`;--> statement-breakpoint
DROP TABLE `data_sources`;--> statement-breakpoint
ALTER TABLE `__new_data_sources` RENAME TO `data_sources`;--> statement-breakpoint
CREATE UNIQUE INDEX `data_sources_org_id_uq` ON `data_sources` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `__new_play_counts` (
	`org_id` text NOT NULL,
	`screen_id` text NOT NULL,
	`hour` integer NOT NULL,
	`spot_id` text NOT NULL,
	`plays` integer DEFAULT 0 NOT NULL,
	`ms` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`org_id`, `screen_id`, `hour`, `spot_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`screen_id`) REFERENCES `screens`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_play_counts`("org_id", "screen_id", "hour", "spot_id", "plays", "ms") SELECT "org_id", "screen_id", "hour", "spot_id", "plays", "ms" FROM `play_counts`;--> statement-breakpoint
DROP TABLE `play_counts`;--> statement-breakpoint
ALTER TABLE `__new_play_counts` RENAME TO `play_counts`;--> statement-breakpoint
CREATE INDEX `play_counts_org_hour_idx` ON `play_counts` (`org_id`,`hour`);--> statement-breakpoint
CREATE TABLE `__new_playlist_items` (
	`org_id` text NOT NULL,
	`playlist_id` text NOT NULL,
	`position` integer NOT NULL,
	`spot_id` text NOT NULL,
	PRIMARY KEY(`org_id`, `playlist_id`, `position`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`playlist_id`) REFERENCES `playlists`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`spot_id`) REFERENCES `spots`(`org_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_playlist_items`("org_id", "playlist_id", "position", "spot_id") SELECT "org_id", "playlist_id", "position", "spot_id" FROM `playlist_items`;--> statement-breakpoint
DROP TABLE `playlist_items`;--> statement-breakpoint
ALTER TABLE `__new_playlist_items` RENAME TO `playlist_items`;--> statement-breakpoint
CREATE INDEX `playlist_items_spot_idx` ON `playlist_items` (`org_id`,`spot_id`);--> statement-breakpoint
CREATE TABLE `__new_playlists` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`transition_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_playlists`("id", "org_id", "name", "transition_json", "created_at", "updated_at") SELECT "id", "org_id", "name", "transition_json", "created_at", "updated_at" FROM `playlists`;--> statement-breakpoint
DROP TABLE `playlists`;--> statement-breakpoint
ALTER TABLE `__new_playlists` RENAME TO `playlists`;--> statement-breakpoint
CREATE UNIQUE INDEX `playlists_org_id_uq` ON `playlists` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `__new_publish_screens` (
	`org_id` text NOT NULL,
	`publish_id` text NOT NULL,
	`screen_id` text NOT NULL,
	`manifest_id` text NOT NULL,
	PRIMARY KEY(`org_id`, `publish_id`, `screen_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`publish_id`) REFERENCES `publishes`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`screen_id`) REFERENCES `screens`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_publish_screens`("org_id", "publish_id", "screen_id", "manifest_id") SELECT "org_id", "publish_id", "screen_id", "manifest_id" FROM `publish_screens`;--> statement-breakpoint
DROP TABLE `publish_screens`;--> statement-breakpoint
ALTER TABLE `__new_publish_screens` RENAME TO `publish_screens`;--> statement-breakpoint
CREATE INDEX `publish_screens_screen_idx` ON `publish_screens` (`org_id`,`screen_id`);--> statement-breakpoint
CREATE TABLE `__new_publishes` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`status` text NOT NULL,
	`publish_at` integer,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_publishes`("id", "org_id", "status", "publish_at", "actor_kind", "actor_id", "created_at", "finished_at") SELECT "id", "org_id", "status", "publish_at", "actor_kind", "actor_id", "created_at", "finished_at" FROM `publishes`;--> statement-breakpoint
DROP TABLE `publishes`;--> statement-breakpoint
ALTER TABLE `__new_publishes` RENAME TO `publishes`;--> statement-breakpoint
CREATE UNIQUE INDEX `publishes_org_id_uq` ON `publishes` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `publishes_org_created_idx` ON `publishes` (`org_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_schedule_entries` (
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
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`playlist_id`) REFERENCES `playlists`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`group_id`) REFERENCES `screen_groups`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`screen_id`) REFERENCES `screens`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "schedule_entries_target_ck" CHECK(("__new_schedule_entries"."target" = 'org' AND "__new_schedule_entries"."group_id" IS NULL AND "__new_schedule_entries"."screen_id" IS NULL)
        OR ("__new_schedule_entries"."target" = 'group' AND "__new_schedule_entries"."group_id" IS NOT NULL AND "__new_schedule_entries"."screen_id" IS NULL)
        OR ("__new_schedule_entries"."target" = 'screen' AND "__new_schedule_entries"."screen_id" IS NOT NULL AND "__new_schedule_entries"."group_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_schedule_entries`("id", "org_id", "playlist_id", "priority", "target", "group_id", "screen_id", "start_date", "end_date", "days_json", "from_time", "to_time", "created_at", "updated_at") SELECT "id", "org_id", "playlist_id", "priority", "target", "group_id", "screen_id", "start_date", "end_date", "days_json", "from_time", "to_time", "created_at", "updated_at" FROM `schedule_entries`;--> statement-breakpoint
DROP TABLE `schedule_entries`;--> statement-breakpoint
ALTER TABLE `__new_schedule_entries` RENAME TO `schedule_entries`;--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_entries_org_id_uq` ON `schedule_entries` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `schedule_entries_org_playlist_idx` ON `schedule_entries` (`org_id`,`playlist_id`);--> statement-breakpoint
CREATE TABLE `__new_screen_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`screen_id` text NOT NULL,
	`secret_hash` text NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`screen_id`) REFERENCES `screens`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_screen_credentials`("id", "org_id", "screen_id", "secret_hash", "last_used_at", "revoked_at", "created_at") SELECT "id", "org_id", "screen_id", "secret_hash", "last_used_at", "revoked_at", "created_at" FROM `screen_credentials`;--> statement-breakpoint
DROP TABLE `screen_credentials`;--> statement-breakpoint
ALTER TABLE `__new_screen_credentials` RENAME TO `screen_credentials`;--> statement-breakpoint
CREATE UNIQUE INDEX `screen_credentials_org_id_uq` ON `screen_credentials` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `screen_credentials_screen_idx` ON `screen_credentials` (`org_id`,`screen_id`);--> statement-breakpoint
CREATE TABLE `__new_screen_group_members` (
	`org_id` text NOT NULL,
	`group_id` text NOT NULL,
	`screen_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `group_id`, `screen_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`group_id`) REFERENCES `screen_groups`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`screen_id`) REFERENCES `screens`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_screen_group_members`("org_id", "group_id", "screen_id", "created_at") SELECT "org_id", "group_id", "screen_id", "created_at" FROM `screen_group_members`;--> statement-breakpoint
DROP TABLE `screen_group_members`;--> statement-breakpoint
ALTER TABLE `__new_screen_group_members` RENAME TO `screen_group_members`;--> statement-breakpoint
CREATE INDEX `screen_group_members_screen_idx` ON `screen_group_members` (`org_id`,`screen_id`);--> statement-breakpoint
CREATE TABLE `__new_screen_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_screen_groups`("id", "org_id", "name", "created_at", "updated_at") SELECT "id", "org_id", "name", "created_at", "updated_at" FROM `screen_groups`;--> statement-breakpoint
DROP TABLE `screen_groups`;--> statement-breakpoint
ALTER TABLE `__new_screen_groups` RENAME TO `screen_groups`;--> statement-breakpoint
CREATE UNIQUE INDEX `screen_groups_org_id_uq` ON `screen_groups` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `__new_screens` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`timezone` text NOT NULL,
	`locale` text,
	`orientation` text NOT NULL,
	`display_hours_json` text,
	`desired_manifest_id` text,
	`previous_manifest_id` text,
	`reported_manifest_id` text,
	`last_seen_at` integer,
	`player_version` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_screens`("id", "org_id", "name", "timezone", "locale", "orientation", "display_hours_json", "desired_manifest_id", "previous_manifest_id", "reported_manifest_id", "last_seen_at", "player_version", "status", "created_at", "updated_at") SELECT "id", "org_id", "name", "timezone", "locale", "orientation", "display_hours_json", "desired_manifest_id", "previous_manifest_id", "reported_manifest_id", "last_seen_at", "player_version", "status", "created_at", "updated_at" FROM `screens`;--> statement-breakpoint
DROP TABLE `screens`;--> statement-breakpoint
ALTER TABLE `__new_screens` RENAME TO `screens`;--> statement-breakpoint
CREATE UNIQUE INDEX `screens_org_id_uq` ON `screens` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `screens_org_name_idx` ON `screens` (`org_id`,`name`);--> statement-breakpoint
CREATE TABLE `__new_spots` (
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
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_version_id`) REFERENCES `template_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`asset_id`) REFERENCES `assets`(`org_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_spots`("id", "org_id", "name", "kind", "duration_ms", "template_version_id", "data_json", "asset_map_json", "bindings_json", "asset_id", "fit", "url", "created_at", "updated_at") SELECT "id", "org_id", "name", "kind", "duration_ms", "template_version_id", "data_json", "asset_map_json", "bindings_json", "asset_id", "fit", "url", "created_at", "updated_at" FROM `spots`;--> statement-breakpoint
DROP TABLE `spots`;--> statement-breakpoint
ALTER TABLE `__new_spots` RENAME TO `spots`;--> statement-breakpoint
CREATE UNIQUE INDEX `spots_org_id_uq` ON `spots` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `spots_org_asset_idx` ON `spots` (`org_id`,`asset_id`);--> statement-breakpoint
CREATE TABLE `__new_template_versions` (
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
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`template_id`) REFERENCES `templates`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_template_versions`("id", "org_id", "template_id", "version", "manifest_json", "bundle_sha256", "status", "check_report_json", "created_at", "updated_at") SELECT "id", "org_id", "template_id", "version", "manifest_json", "bundle_sha256", "status", "check_report_json", "created_at", "updated_at" FROM `template_versions`;--> statement-breakpoint
DROP TABLE `template_versions`;--> statement-breakpoint
ALTER TABLE `__new_template_versions` RENAME TO `template_versions`;--> statement-breakpoint
CREATE UNIQUE INDEX `template_versions_org_id_uq` ON `template_versions` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `template_versions_org_version_uq` ON `template_versions` (`org_id`,`template_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `template_versions_base_version_uq` ON `template_versions` (`template_id`,`version`) WHERE "template_versions"."org_id" IS NULL;--> statement-breakpoint
CREATE TABLE `__new_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_templates`("id", "org_id", "key", "name", "created_at", "updated_at") SELECT "id", "org_id", "key", "name", "created_at", "updated_at" FROM `templates`;--> statement-breakpoint
DROP TABLE `templates`;--> statement-breakpoint
ALTER TABLE `__new_templates` RENAME TO `templates`;--> statement-breakpoint
CREATE UNIQUE INDEX `templates_org_id_uq` ON `templates` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `templates_org_key_uq` ON `templates` (`org_id`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `templates_base_key_uq` ON `templates` (`key`) WHERE "templates"."org_id" IS NULL;