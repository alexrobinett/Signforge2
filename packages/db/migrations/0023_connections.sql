CREATE TABLE `connection_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`connection_id` text,
	`state_hash` text NOT NULL,
	`verifier_sealed` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`connection_id`) REFERENCES `connections`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connection_authorizations_org_id_uq` ON `connection_authorizations` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `connection_authorizations_state_uq` ON `connection_authorizations` (`org_id`,`state_hash`);--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`account` text NOT NULL,
	`scopes_json` text NOT NULL,
	`status` text NOT NULL,
	`credentials_sealed` text,
	`expires_at` integer,
	`created_by` text NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connections_org_id_uq` ON `connections` (`org_id`,`id`);--> statement-breakpoint
ALTER TABLE `data_sources` ADD `connection_id` text;