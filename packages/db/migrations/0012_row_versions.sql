ALTER TABLE `brand_kits` ADD `row_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `screen_groups` ADD `row_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `screens` ADD `row_version` integer DEFAULT 1 NOT NULL;