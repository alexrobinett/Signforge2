# Player release test vector (#628)

For tests only. `test-only.key.pem` and `test-only.pub.pem` are an Ed25519 key pair that signs nothing real: no screen
ships this public key. `vector.json` holds:

- `publicKey`: the public key, base64 DER, as the PEM file;
- `tarball`: a real release tarball, base64, in the format the contract states (`packages/contract/src/shapes.ts`,
  player releases): gzip, `./`, two files and a directory;
- `manifest`: its release manifest's text, which names that tarball's size and sha256 and its files' hashes;
- `signature`: Ed25519 by the test key over the UTF-8 bytes of `manifest` exactly, with no trailing newline, in
  standard base64 with padding, as CI signs a release.

The contract's tests check it, and the release workflow's packer and the supervisor's extractor test against it, so
all three make, sign, verify and unpack the same bytes. The tarball was written with ustar headers, mtime 0 and no
owner, and gzip with mtime 0, so it can be made again byte for byte.
