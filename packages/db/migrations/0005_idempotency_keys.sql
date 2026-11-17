CREATE TABLE `idempotency_keys` (
	`org_id` text NOT NULL,
	`key` text NOT NULL,
	`action` text NOT NULL,
	`input_sha256` text NOT NULL,
	`output_json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `key`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
