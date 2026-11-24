-- An org always keeps an owner (#292). Better Auth counts the owners and then writes, in separate
-- statements with no transaction, so two owners demoting, removing or leaving at once could each
-- see the other and leave none. These make each write that takes away an owner refuse itself, in
-- its own statement, when no other owner would remain (`isLastOwnerRefusal` in src/members.ts).
-- They refuse a cascade that would delete an org's last owner too, so a ticket that turns org or
-- user deletion on must handle that. Hand-written: drizzle-kit does not model triggers.
CREATE TRIGGER `member_keeps_an_owner_on_role` BEFORE UPDATE OF `role` ON `member`
	WHEN OLD.`role` = 'owner' AND NEW.`role` <> 'owner' AND NOT EXISTS (
		SELECT 1 FROM `member` WHERE `organizationId` = OLD.`organizationId` AND `role` = 'owner' AND `id` <> OLD.`id`
	)
BEGIN
	SELECT RAISE(ABORT, 'org_needs_an_owner');
END;
--> statement-breakpoint
CREATE TRIGGER `member_keeps_an_owner_on_delete` BEFORE DELETE ON `member`
	WHEN OLD.`role` = 'owner' AND NOT EXISTS (
		SELECT 1 FROM `member` WHERE `organizationId` = OLD.`organizationId` AND `role` = 'owner' AND `id` <> OLD.`id`
	)
BEGIN
	SELECT RAISE(ABORT, 'org_needs_an_owner');
END;
