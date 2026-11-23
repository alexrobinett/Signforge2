-- Spike only. Dev sign-in codes, readable at GET /dev/otp, and the agent grant a consent creates:
-- the grant id is the consent's reference id, so every token issued from the consent carries it.
CREATE TABLE spike_otp (email TEXT PRIMARY KEY, otp TEXT NOT NULL);
CREATE TABLE spike_grants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organization (id),
  user_id TEXT NOT NULL REFERENCES user (id),
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
