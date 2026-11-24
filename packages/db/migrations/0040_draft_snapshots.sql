CREATE TABLE `draft_snapshots` (
	`org_id` text NOT NULL,
	`spot_id` text,
	`playlist_id` text,
	`holds` text NOT NULL,
	`content_json` text NOT NULL,
	`sample_fields_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`spot_id`) REFERENCES `spots`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`playlist_id`) REFERENCES `playlists`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "draft_snapshots_one_draft" CHECK(("draft_snapshots"."spot_id" IS NULL) <> ("draft_snapshots"."playlist_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draft_snapshots_spot_uq` ON `draft_snapshots` (`org_id`,`spot_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `draft_snapshots_playlist_uq` ON `draft_snapshots` (`org_id`,`playlist_id`);