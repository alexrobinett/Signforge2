ALTER TABLE `user` ADD `lastActiveOrganizationId` text;--> statement-breakpoint
-- A new session's org is one the user is a member of when the insert runs (#182, review of #208): one
-- removed after the session create hook read it is cleared in the same statement. Hand-written:
-- drizzle-kit does not model triggers.
CREATE TRIGGER `session_org_is_a_membership` AFTER INSERT ON `session`
	WHEN NEW.`activeOrganizationId` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `member` WHERE `member`.`userId` = NEW.`userId` AND `member`.`organizationId` = NEW.`activeOrganizationId`
	)
BEGIN
	UPDATE `session` SET `activeOrganizationId` = NULL WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
-- The org a session switches to is remembered with the switch, in the same statement, and only
-- when the org changes: an expiry refresh from another device leaves the remembered org alone.
CREATE TRIGGER `session_org_remembered` AFTER UPDATE OF `activeOrganizationId` ON `session`
	WHEN NEW.`activeOrganizationId` IS NOT NULL AND NEW.`activeOrganizationId` IS NOT OLD.`activeOrganizationId`
BEGIN
	UPDATE `user` SET `lastActiveOrganizationId` = NEW.`activeOrganizationId` WHERE `id` = NEW.`userId`;
END;
