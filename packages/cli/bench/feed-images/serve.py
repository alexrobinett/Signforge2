#!/usr/bin/env python3
"""Serve player builds and the feed-image bench's content (make.ts's output) from one origin.

  serve.py <dir> [port, default 8093]

Everything under <dir> as http://127.0.0.1:<port>/..., for instance <dir>/pr/ (a player build) and
<dir>/content/landscape/ (make.ts's output), played as /pr/index.html?content=/content/landscape. One
origin, since content on another is the API to the player. A blob is served with the type a
types.json beside it names: the player refuses a feed image not served as an image, and Python's
http.server types a file by its extension, which a blob has none of.
"""
import glob, json, os, sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

root = sys.argv[1]
port = int(sys.argv[2]) if len(sys.argv) > 2 else 8093
types = {}
for f in glob.glob(os.path.join(root, "**", "types.json"), recursive=True):
    with open(f) as fh:
        types.update(json.load(fh))


class Handler(SimpleHTTPRequestHandler):
    def guess_type(self, path):
        return types.get(os.path.basename(path)) or super().guess_type(path)

    def end_headers(self):
        self.send_header("cache-control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=root)).serve_forever()
