ALTER TABLE `playlists` ADD `published_version` integer;--> statement-breakpoint
ALTER TABLE `schedule_entries` ADD `published_version` integer;--> statement-breakpoint
ALTER TABLE `spots` ADD `published_version` integer;--> statement-breakpoint
-- A published draft not edited since its publish is at the version promoted; one edited since is behind it (#361).
UPDATE `playlists` SET `published_version` = CASE WHEN `updated_at` > `published_at` THEN `row_version` - 1 ELSE `row_version` END WHERE `published_at` IS NOT NULL;
--> statement-breakpoint
-- A published draft not edited since its publish is at the version promoted; one edited since is behind it (#361).
UPDATE `schedule_entries` SET `published_version` = CASE WHEN `updated_at` > `published_at` THEN `row_version` - 1 ELSE `row_version` END WHERE `published_at` IS NOT NULL;
--> statement-breakpoint
-- A published draft not edited since its publish is at the version promoted; one edited since is behind it (#361).
UPDATE `spots` SET `published_version` = CASE WHEN `updated_at` > `published_at` THEN `row_version` - 1 ELSE `row_version` END WHERE `published_at` IS NOT NULL;
