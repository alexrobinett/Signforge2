CREATE TABLE `player_releases` (
	`version` integer PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`manifest` text NOT NULL,
	`signature` text NOT NULL,
	`channel` text NOT NULL,
	`created_at` integer NOT NULL,
	`promoted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `player_releases_sha256_uq` ON `player_releases` (`sha256`);--> statement-breakpoint
CREATE INDEX `player_releases_channel_version_idx` ON `player_releases` (`channel`,`version`);--> statement-breakpoint
ALTER TABLE `screens` ADD `player_channel` text DEFAULT 'stable' NOT NULL;