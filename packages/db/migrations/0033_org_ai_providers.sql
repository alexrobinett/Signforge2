CREATE TABLE `org_ai_providers` (
	`org_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`key_sealed` text NOT NULL,
	`key_last4` text NOT NULL,
	`key_saved_by` text NOT NULL,
	`key_saved_at` integer NOT NULL,
	`verified_at` integer,
	`fast_model` text,
	`capable_model` text,
	`daily_turn_ceiling` integer,
	`row_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
