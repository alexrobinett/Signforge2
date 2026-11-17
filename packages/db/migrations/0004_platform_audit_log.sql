CREATE TABLE `platform_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`client_id` text,
	`action` text NOT NULL,
	`target_kind` text,
	`target_id` text,
	`detail_json` text
);
--> statement-breakpoint
CREATE INDEX `platform_audit_log_at_idx` ON `platform_audit_log` (`at`);