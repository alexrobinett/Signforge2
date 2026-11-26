# Player release test vector (#628)

For tests only. `test-only.key.pem` and `test-only.pub.pem` are an Ed25519 key pair that signs nothing real: no screen
ships this public key. `vector.json` holds the public key (base64 DER, as the PEM file), one release manifest's text and its signature by that key, made as CI makes
a release's: Ed25519 over the UTF-8 bytes of `manifest` exactly, with no trailing newline, in standard base64 with
padding. The contract's tests check it, and the release workflow's and the supervisor's tests check against it, so
all three sign and verify the same bytes.
