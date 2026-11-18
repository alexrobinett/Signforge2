ALTER TABLE `pairing_codes` ADD `kind` text DEFAULT 'device' NOT NULL;--> statement-breakpoint
ALTER TABLE `screens` ADD `kind` text DEFAULT 'device' NOT NULL;