-- SQLite cannot add a NOT NULL column without a default; existing snapshots count as checked when fetched.
ALTER TABLE `data_snapshots` ADD `checked_at` integer NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE `data_snapshots` SET `checked_at` = `fetched_at`;--> statement-breakpoint
ALTER TABLE `data_sources` ADD `horizon_days` integer;
