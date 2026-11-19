-- SQLite adds a NOT NULL column only with a default. No publish row exists before this migration (nothing wrote one but tests), and every new row names its revision.
ALTER TABLE `publishes` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `publishes` ADD `restores_id` text;--> statement-breakpoint
ALTER TABLE `publishes` ADD `reached` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `publishes_org_revision_uq` ON `publishes` (`org_id`,`revision`);--> statement-breakpoint
CREATE INDEX `publishes_unfinished_idx` ON `publishes` (`org_id`) WHERE "publishes"."finished_at" IS NULL;