ALTER TABLE `org_ai_providers` ADD `base_url` text;--> statement-breakpoint
ALTER TABLE `org_ai_providers` ADD `accepts_images` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `org_ai_providers` ADD `json_schema_output` integer DEFAULT false NOT NULL;