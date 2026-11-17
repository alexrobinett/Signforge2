CREATE TABLE `brand_assignments` (
	`org_id` text NOT NULL,
	`target` text NOT NULL,
	`group_id` text,
	`screen_id` text,
	`brand_kit_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`brand_kit_id`) REFERENCES `brand_kits`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`group_id`) REFERENCES `screen_groups`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`screen_id`) REFERENCES `screens`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "brand_assignments_target_ck" CHECK(("brand_assignments"."target" = 'org' AND "brand_assignments"."group_id" IS NULL AND "brand_assignments"."screen_id" IS NULL)
        OR ("brand_assignments"."target" = 'group' AND "brand_assignments"."group_id" IS NOT NULL AND "brand_assignments"."screen_id" IS NULL)
        OR ("brand_assignments"."target" = 'screen' AND "brand_assignments"."screen_id" IS NOT NULL AND "brand_assignments"."group_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brand_assignments_org_uq` ON `brand_assignments` (`org_id`) WHERE "brand_assignments"."target" = 'org';--> statement-breakpoint
CREATE UNIQUE INDEX `brand_assignments_group_uq` ON `brand_assignments` (`org_id`,`group_id`) WHERE "brand_assignments"."group_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `brand_assignments_screen_uq` ON `brand_assignments` (`org_id`,`screen_id`) WHERE "brand_assignments"."screen_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `brand_assignments_kit_idx` ON `brand_assignments` (`org_id`,`brand_kit_id`);--> statement-breakpoint
CREATE TABLE `brand_kits` (
	`id` text NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`colors_json` text NOT NULL,
	`shape` text NOT NULL,
	`display_font_id` text,
	`body_font_id` text,
	`logo_on_dark_asset_id` text,
	`logo_on_light_asset_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `id`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`logo_on_dark_asset_id`) REFERENCES `assets`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`logo_on_light_asset_id`) REFERENCES `assets`(`org_id`,`id`) ON UPDATE no action ON DELETE no action
);
