CREATE TABLE fanout_screens (run TEXT NOT NULL, screen TEXT NOT NULL, manifest_id TEXT NOT NULL);
CREATE TABLE fanout_batches (run TEXT NOT NULL, batch_size INTEGER NOT NULL, subrequests INTEGER NOT NULL, error TEXT, at INTEGER NOT NULL);
