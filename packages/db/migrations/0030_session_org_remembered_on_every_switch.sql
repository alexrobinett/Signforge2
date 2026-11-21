-- A switch is remembered even to the org the session was already on (re-check of #208): that is the
-- member's latest choice, which another device's switch since must not outrank. The column list
-- alone keeps an expiry refresh out: Better Auth's refresh sets only `expiresAt` and `updatedAt`.
-- Hand-written: drizzle-kit does not model triggers.
DROP TRIGGER `session_org_remembered`;
--> statement-breakpoint
CREATE TRIGGER `session_org_remembered` AFTER UPDATE OF `activeOrganizationId` ON `session`
	WHEN NEW.`activeOrganizationId` IS NOT NULL
BEGIN
	UPDATE `user` SET `lastActiveOrganizationId` = NEW.`activeOrganizationId` WHERE `id` = NEW.`userId`;
END;
