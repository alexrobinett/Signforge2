#!/usr/bin/env python3
"""Stand-in for the backend's data-source poller (until Milestone 3).

Reads content/data-sources.json, fetches each feed on its interval, converts it to the shape
the contract defines, and writes content/data/<id>.json as {id, fetchedAt, data}.

Formats:
  json   passed through unchanged
  ical   an iCalendar feed (Google Calendar, Outlook, ...)  -> CalendarFeed {events: [...]}
  rss    an RSS 2.0 or Atom feed                             -> NewsFeed {title, items: [...]}
"""
import json, os, re, time, urllib.error, urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from zoneinfo import ZoneInfo

WWW = os.path.expanduser("~/signforge/www/content")
TICK_S = 15
MAX_EVENTS = 25
MAX_ITEMS = 20
MAX_BYTES = 2_000_000
SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class HttpsOnly(urllib.request.HTTPRedirectHandler):
    """Follow redirects only to https, never to file: or plain http."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith("https://"):
            raise urllib.error.URLError(f"refusing redirect to {newurl[:60]}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


opener = urllib.request.build_opener(HttpsOnly)


def fetch(url):
    if not url.startswith("https://"):
        raise ValueError("feeds must be https")
    req = urllib.request.Request(url, headers={"User-Agent": "signforge-dev"})
    with opener.open(req, timeout=20) as r:
        raw = r.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError(f"feed is larger than {MAX_BYTES} bytes")
    return raw.decode("utf-8", "replace")


# ------------------------------------------------------------------ iCalendar

def ical_lines(text):
    """Unfold continuation lines (RFC 5545 3.1)."""
    out = []
    for line in text.replace("\r\n", "\n").split("\n"):
        if line[:1] in (" ", "\t") and out:
            out[-1] += line[1:]
        elif line:
            out.append(line)
    return out


def ical_unescape(v):
    return v.replace("\\n", " ").replace("\\N", " ").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\").strip()


def ical_time(params, value, default_tz):
    """Return (datetime or date, all_day)."""
    if params.get("VALUE") == "DATE" or re.fullmatch(r"\d{8}", value):
        return date(int(value[:4]), int(value[4:6]), int(value[6:8])), True
    dt = datetime.strptime(value.rstrip("Z"), "%Y%m%dT%H%M%S")
    if value.endswith("Z"):
        return dt.replace(tzinfo=timezone.utc), False
    try:
        tz = ZoneInfo(params.get("TZID") or default_tz)
    except Exception:
        tz = timezone.utc
    return dt.replace(tzinfo=tz), False


def parse_ical(text):
    default_tz, events, ev = "UTC", [], None
    for line in ical_lines(text):
        name, _, value = line.partition(":")
        key, *rest = name.split(";")
        params = dict(p.split("=", 1) for p in rest if "=" in p)
        if key == "X-WR-TIMEZONE":
            default_tz = value.strip()
        elif key == "BEGIN" and value == "VEVENT":
            ev = {}
        elif key == "END" and value == "VEVENT" and ev is not None:
            events.append(ev)
            ev = None
        elif ev is not None:
            if key in ("DTSTART", "DTEND"):
                ev[key] = ical_time(params, value.strip(), default_tz)
            elif key in ("SUMMARY", "LOCATION", "STATUS"):
                ev[key] = ical_unescape(value)
    now = datetime.now(timezone.utc)
    today = now.date()
    out = []
    for ev in events:
        if "DTSTART" not in ev or ev.get("STATUS") == "CANCELLED":
            continue
        start, all_day = ev["DTSTART"]
        end = ev.get("DTEND", (start + timedelta(days=1) if all_day else start + timedelta(hours=1), all_day))[0]
        # Recurring events (RRULE) are not expanded by this stand-in; the real poller will.
        if (end <= today) if all_day else (end <= now):
            continue
        out.append({
            "title": ev.get("SUMMARY", "Untitled"),
            "start": start.isoformat(),
            "end": end.isoformat(),
            "allDay": all_day,
            "location": ev.get("LOCATION", ""),
            "_sort": datetime.combine(start, datetime.min.time(), timezone.utc) if all_day else start,
        })
    out.sort(key=lambda e: e["_sort"])
    for e in out:
        del e["_sort"]
    return {"events": out[:MAX_EVENTS]}


# ------------------------------------------------------------------------ RSS

def parse_rss(text):
    # Entity declarations are how XML bombs work, and no real feed needs them.
    if re.search(r"<!(?:DOCTYPE|ENTITY)", text[:4096], re.I) or "<!ENTITY" in text:
        raise ValueError("feed declares a DOCTYPE or entities")
    root = ET.fromstring(text)
    strip = lambda tag: tag.split("}")[-1]
    channel = root.find("channel")
    items, title = [], ""
    if channel is not None:  # RSS 2.0
        title = (channel.findtext("title") or "").strip()
        for it in channel.findall("item"):
            pub = it.findtext("pubDate") or ""
            try:
                pub = parsedate_to_datetime(pub).astimezone(timezone.utc).isoformat()
            except Exception:
                pass
            items.append({"title": (it.findtext("title") or "").strip(), "published": pub, "source": title})
    else:  # Atom
        for el in root:
            if strip(el.tag) == "title":
                title = (el.text or "").strip()
        for entry in [e for e in root if strip(e.tag) == "entry"]:
            fields = {strip(c.tag): (c.text or "").strip() for c in entry}
            items.append({"title": fields.get("title", ""), "published": fields.get("updated", fields.get("published", "")), "source": title})
    items = [i for i in items if i["title"]]
    return {"title": title, "items": items[:MAX_ITEMS]}


# ----------------------------------------------------------------------- loop

CONVERT = {"json": lambda raw: json.loads(raw), "ical": parse_ical, "rss": parse_rss}
last_fetch = {}


def tick():
    with open(os.path.join(WWW, "data-sources.json")) as f:
        sources = json.load(f)
    os.makedirs(os.path.join(WWW, "data"), exist_ok=True)
    for sid, src in sources.items():
        if not SAFE_ID.match(sid):  # the id becomes a file name
            print(f"skipping source with unsafe id {sid[:40]!r}", flush=True)
            continue
        if time.time() - last_fetch.get(sid, 0) < max(60, src.get("refreshS", 300)):
            continue
        last_fetch[sid] = time.time()
        try:
            raw = fetch(src["url"])
            data = CONVERT[src.get("format", "json")](raw)
            snap = {"id": sid, "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "data": data}
            tmp = os.path.join(WWW, "data", f".{sid}.tmp")
            with open(tmp, "w") as f:
                json.dump(snap, f)
            os.replace(tmp, os.path.join(WWW, "data", f"{sid}.json"))
            print(f"{snap['fetchedAt']} {sid} updated", flush=True)
        except Exception as e:  # keep the last good snapshot
            print(f"{sid} failed: {e}", flush=True)


while True:
    try:
        tick()
    except Exception as e:
        print(f"datad: {e}", flush=True)
    time.sleep(TICK_S)
