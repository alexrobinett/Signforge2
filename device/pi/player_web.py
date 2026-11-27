"""player-web: serves ~/signforge/www, the link to the player build in use, on 127.0.0.1:8090, standing in for the CDN.

Every reply says `Cache-Control: no-store` (#628). `python3 -m http.server` sends no cache headers, so Chromium kept a
build's files after a switch: after a rollback, the failed build's index.html naming scripts no longer there; after an
update, the old build, which the health gate would then roll a good release back for. The link is followed on each
request, so a switch needs no restart.
"""
import functools
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = 8090


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def server(root, port=PORT):
    return ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=root))


if __name__ == "__main__":
    server(os.path.expanduser("~/signforge/www")).serve_forever()
