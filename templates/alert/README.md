# Alert

A takeover for emergencies and notices. What it draws and why are in `docs/template-spec.md` (Alert).

## Moving a spot to 1.1.0 (#230)

1.1.0 draws the QR code at 40vmin, so a link of up to 213 bytes scans from 2 m on a 55-inch panel. 1.0.x draws it at 23vmin. A spot keeps the template version it was made on, and nothing moves it: `save_spot` changes a draft's data, not its template version. Seeding 1.1.0 adds it beside 1.0.x, and every 1.0.x spot keeps the small code until it is made again.

For each Alert spot on 1.0.x:

1. Make a new spot from Alert 1.1.0: **New spot** in the CMS, or `save_spot` with 1.1.0's `templateVersionId` from `list_templates`.
2. Copy its fields over. 1.1.0 refuses a QR link over 213 bytes (some characters use more than one byte) and a headline over 40 characters, so shorten those.
3. Put the new spot where the old one was in each of its playlists, and publish. For a takeover that is running, do the same in the takeover's playlist rather than starting another takeover. Screens play the old spot until that publish.
4. Delete the old spot once nothing uses it.

To stop new spots being made on 1.0.x, retire it (`set_template_version_status`). Spots already on it keep playing.
