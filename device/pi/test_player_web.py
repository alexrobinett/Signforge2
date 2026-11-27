"""player-web (#628): every reply says no-store, so Chromium keeps no build in its cache, and the link to the build in
use is followed on each request. On a free port, with a temporary home: no Pi.

Run from the repo root: python3 -m unittest discover -s device/pi -p 'test_*.py'
"""
import os, sys, tempfile, threading, unittest
from urllib.request import urlopen

sys.path.insert(0, os.path.dirname(__file__))
import player_web


class PlayerWeb(unittest.TestCase):
    def test_answers_with_no_store_and_follows_a_switch_at_once(self):
        home = tempfile.mkdtemp()
        for v in ("7", "42"):
            os.makedirs(os.path.join(home, "players", v))
            with open(os.path.join(home, "players", v, "index.html"), "w") as f:
                f.write(f"build {v}")
        www = os.path.join(home, "www")
        os.symlink("players/7", www)
        server = player_web.server(www, 0)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_port}/index.html"
        with urlopen(url) as r:
            self.assertEqual((r.read(), r.headers["Cache-Control"]), (b"build 7", "no-store"))
        os.symlink("players/42", www + ".new")
        os.replace(www + ".new", www)
        with urlopen(url) as r:
            self.assertEqual((r.read(), r.headers["Cache-Control"]), (b"build 42", "no-store"))
        # A file the build does not have is a 404, with no-store too.
        with self.assertRaises(Exception) as e:
            urlopen(url.replace("index.html", "assets/gone.js"))
        self.assertEqual((e.exception.code, e.exception.headers["Cache-Control"]), (404, "no-store"))
        e.exception.close()


if __name__ == "__main__":
    unittest.main()
