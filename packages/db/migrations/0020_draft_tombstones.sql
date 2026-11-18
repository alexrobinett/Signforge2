CREATE TABLE `draft_tombstones` (
	`org_id` text NOT NULL,
	`draft_table` text NOT NULL,
	`draft_id` text NOT NULL,
	`row_version` integer NOT NULL,
	PRIMARY KEY(`org_id`, `draft_table`, `draft_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- Written by hand (drizzle-kit does not model triggers): every delete of a draft, a cascade too, keeps its last version.
CREATE TRIGGER `spots_tombstone` AFTER DELETE ON `spots` BEGIN
	INSERT OR REPLACE INTO `draft_tombstones` (`org_id`, `draft_table`, `draft_id`, `row_version`) VALUES (OLD.`org_id`, 'spots', OLD.`id`, OLD.`row_version`);
END;
--> statement-breakpoint
CREATE TRIGGER `playlists_tombstone` AFTER DELETE ON `playlists` BEGIN
	INSERT OR REPLACE INTO `draft_tombstones` (`org_id`, `draft_table`, `draft_id`, `row_version`) VALUES (OLD.`org_id`, 'playlists', OLD.`id`, OLD.`row_version`);
END;
--> statement-breakpoint
CREATE TRIGGER `schedule_entries_tombstone` AFTER DELETE ON `schedule_entries` BEGIN
	INSERT OR REPLACE INTO `draft_tombstones` (`org_id`, `draft_table`, `draft_id`, `row_version`) VALUES (OLD.`org_id`, 'schedule_entries', OLD.`id`, OLD.`row_version`);
END;
