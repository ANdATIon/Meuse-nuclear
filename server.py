#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Chooz / Meuse dashboard backend.

Two jobs:
  1. Serve index.html (and any other static file in this folder).
  2. Proxy the ENTSO-E Transparency Platform API so the API token never
     reaches the browser. Responses are normalised to small JSON payloads
     and cached in memory for at least 15 minutes.

Endpoints
  GET /api/entsoe/health
  GET /api/entsoe/plants                                    (config only)
  GET /api/entsoe/generation?from=YYYY-MM-DD&to=YYYY-MM-DD   (to exclusive)
  GET /api/entsoe/outages?from=YYYY-MM-DD&to=YYYY-MM-DD      (to exclusive)

Generation is fetched once per bidding zone per day (not per unit), so the
French and Belgian units share their zone's A73 response.

Configuration lives in CONFIG/PLANTS below and in environment variables:
  ENTSOE_TOKEN              required, API security token (never logged)
  ENTSOE_CACHE_TTL          cache seconds (minimum 900)
  ENTSOE_TIMEOUT            upstream request timeout (seconds)
  ENTSOE_MAX_WORKERS        parallel day requests for generation (1-8)
  ENTSOE_OUTAGE_MAX_PAGES   outage pagination cap (200 documents per page)
  ENTSOE_FR_ZONE_EIC        French bidding zone EIC (default 10YFR-RTE------C)
  ENTSOE_BE_ZONE_EIC        Belgian bidding zone EIC (default 10YBE----------2)
  ENTSOE_CHOOZ1_EIC         optional exact EIC for Chooz B1
  ENTSOE_CHOOZ2_EIC         optional exact EIC for Chooz B2
  ENTSOE_DOEL4_EIC          optional exact EIC for Doel 4
  ENTSOE_TIHANGE3_EIC       optional exact EIC for Tihange 3
  ENTSOE_API_URL            override upstream URL (testing)
  PORT / HOST               HTTP listen address (default 127.0.0.1:8080)
  ALLOWED_ORIGINS           optional comma-separated CORS allowlist

Run:  python server.py
"""

from __future__ import annotations

import hashlib
import io
import json
import mimetypes
import os
import re
import socket
import sys
import threading
import time
import traceback
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlencode, urlsplit
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


CONFIG = {
    "api_url": os.environ.get("ENTSOE_API_URL", "https://web-api.tp.entsoe.eu/api").strip(),

    # Cache: 15 minutes is the documented minimum; longer is allowed.
    "cache_ttl_s": max(900, _env_int("ENTSOE_CACHE_TTL", 900)),
    "cache_max_entries": 64,

    "request_timeout_s": max(5, _env_int("ENTSOE_TIMEOUT", 30)),
    "retries": max(1, min(5, _env_int("ENTSOE_ATTEMPTS", 3))),
    "retry_backoff_s": 2.0,
    "max_workers": max(1, min(8, _env_int("ENTSOE_MAX_WORKERS", 4))),

    # A73 is day-limited and slow: one upstream request per UTC day, at most
    # two in parallel, with a generous timeout and exponential backoff.
    "max_generation_days": 45,
    "default_generation_days": 30,
    "generation_timeout_s": max(30, _env_int("ENTSOE_GENERATION_TIMEOUT", 120)),
    "generation_workers": max(1, min(2, _env_int("ENTSOE_GENERATION_WORKERS", 2))),
    "generation_attempts": max(1, min(5, _env_int("ENTSOE_GENERATION_ATTEMPTS", 3))),
    "generation_refresh_s": max(300, _env_int("ENTSOE_GENERATION_REFRESH", 900)),
    "generation_failure_ttl_s": 120,
    "generation_cache_dir": Path(
        os.environ.get("ENTSOE_GENERATION_CACHE_DIR", "").strip()
        or str(BASE_DIR / "cache" / "generation")
    ),

    # Outages are served as a ZIP with at most 200 documents per page.
    "outage_page_size": 200,
    "outage_max_pages": max(1, min(20, _env_int("ENTSOE_OUTAGE_MAX_PAGES", 4))),
    "max_outage_days": 60,
    "default_outage_back_days": 30,
    "default_outage_forward_days": 8,

    "port": _env_int("PORT", 8080),
    "host": os.environ.get("HOST", "127.0.0.1").strip() or "127.0.0.1",
    # Same-origin is the default; only these origins may call the API cross-origin.
    "allowed_origins": [
        origin.strip()
        for origin in os.environ.get("ALLOWED_ORIGINS", "").split(",")
        if origin.strip()
    ],
}

# ---------------------------------------------------------------------------
# Plants, units and bidding zones (single config list)
# ---------------------------------------------------------------------------
#
# One entry per nuclear plant. The frontend builds its reactor overview and
# plant sections from this list, so adding another plant only needs one entry
# here. Unit EICs are never guessed: the exact ENTSO-E unit name is matched
# first and an operator can pin the EIC through the optional environment
# variable named in "eic_env".


def _env_text(name: str) -> str:
    return os.environ.get(name, "").strip()


FR_ZONE_EIC = _env_text("ENTSOE_FR_ZONE_EIC") or "10YFR-RTE------C"
BE_ZONE_EIC = _env_text("ENTSOE_BE_ZONE_EIC") or "10YBE----------2"

PLANTS = [
    {
        "key": "chooz",
        "label": "Chooz",
        "country": "FR",
        "countryLabel": "Fransa",
        "order": 1,
        "zoneKey": "FR",
        "zoneEic": FR_ZONE_EIC,
        "units": [
            {
                "key": "chooz1",
                "label": "Chooz B1",
                "names": ["CHOOZ1"],
                "eic_env": "ENTSOE_CHOOZ1_EIC",
                "overviewOrder": 1,
            },
            {
                "key": "chooz2",
                "label": "Chooz B2",
                "names": ["CHOOZ2"],
                "eic_env": "ENTSOE_CHOOZ2_EIC",
                "overviewOrder": 2,
            },
        ],
        # Optional river panel; only the first plant carrying stations gets it.
        "river": {
            "label": "Meuse – Chooz",
            "stations": [
                {"code": "B720000001", "name": "Trou du Diable (DREAL)"},
                {"code": "B720000002", "name": "Île Graviat"},
            ],
        },
    },
    {
        "key": "tihange",
        "label": "Tihange",
        "country": "BE",
        "countryLabel": "Belçika",
        "order": 2,
        "zoneKey": "BE",
        "zoneEic": BE_ZONE_EIC,
        "units": [
            {
                "key": "tihange3",
                "label": "Tihange 3",
                "names": ["TIHANGE3"],
                "eic_env": "ENTSOE_TIHANGE3_EIC",
                "overviewOrder": 4,
            }
        ],
    },
    {
        "key": "doel",
        "label": "Doel",
        "country": "BE",
        "countryLabel": "Belçika",
        "order": 3,
        "zoneKey": "BE",
        "zoneEic": BE_ZONE_EIC,
        "units": [
            {
                "key": "doel4",
                "label": "Doel 4",
                "names": ["DOEL4"],
                "eic_env": "ENTSOE_DOEL4_EIC",
                "overviewOrder": 3,
            }
        ],
    },
]

ZONES: dict[str, dict] = {}
for _plant in PLANTS:
    _zone = ZONES.setdefault(
        _plant["zoneKey"],
        {
            "key": _plant["zoneKey"],
            "eic": _plant["zoneEic"],
            "plants": [],
            "units": [],
        },
    )
    _zone["plants"].append(_plant["key"])
    _zone["units"].extend(unit["key"] for unit in _plant["units"])

UNIT_DEFS = []
for _plant in PLANTS:
    for _unit in _plant["units"]:
        UNIT_DEFS.append(
            {
                **(_unit),
                "plantKey": _plant["key"],
                "plantLabel": _plant["label"],
                "plantOrder": _plant["order"],
                "country": _plant["country"],
                "countryLabel": _plant["countryLabel"],
                "zoneKey": _plant["zoneKey"],
                "zoneEic": _plant["zoneEic"],
            }
        )

UNIT_BY_KEY = {u["key"]: u for u in UNIT_DEFS}
ZONE_UNITS = {zone: [u for u in UNIT_DEFS if u["zoneKey"] == zone] for zone in ZONES}
UNIT_OVERVIEW = sorted(UNIT_DEFS, key=lambda u: (u["overviewOrder"], u["label"]))


def plants_public() -> list[dict]:
    """Frontend-friendly plant/unit config; no token or upstream data."""
    return [
        {
            "key": plant["key"],
            "label": plant["label"],
            "country": plant["country"],
            "countryLabel": plant["countryLabel"],
            "order": plant["order"],
            "zone": {"key": plant["zoneKey"], "eic": plant["zoneEic"]},
            "units": [
                {
                    "key": unit["key"],
                    "label": unit["label"],
                    "names": list(unit.get("names") or []),
                    "eic": _env_text(unit["eic_env"]).upper() or None,
                    "overviewOrder": unit["overviewOrder"],
                }
                for unit in plant["units"]
            ],
            "river": plant.get("river"),
        }
        for plant in PLANTS
    ]

STATUS_LABELS = {"A05": "active", "A09": "cancelled", "A13": "withdrawn"}

REASON_LABELS = {
    "A95": "complementary information",
    "B18": "failure",
    "B19": "foreseen maintenance",
    "B20": "shutdown",
}

BUSINESS_LABELS = {"A53": "planned", "A54": "forced"}

UNIT_NAME_PATHS = [
    "production_registeredresource.name",
    "registeredresource.name",
    "mktpsrtype.powersystemresources.name",
    "production_registeredresource.psrtype.powersystemresources.name",
    "production_registeredresource.powersystemresources.name",
    "powersystemresources.name",
]

UNIT_EIC_PATHS = [
    "production_registeredresource.mrid",
    "registeredresource.mrid",
    "mktpsrtype.powersystemresources.mrid",
    "production_registeredresource.psrtype.powersystemresources.mrid",
    "production_registeredresource.powersystemresources.mrid",
    "powersystemresources.mrid",
]

REGISTERED_RESOURCE_PATHS = [
    "production_registeredresource.mrid",
    "registeredresource.mrid",
]

PSR_MRID_PATHS = [
    "mktpsrtype.powersystemresources.mrid",
    "production_registeredresource.psrtype.powersystemresources.mrid",
    "production_registeredresource.powersystemresources.mrid",
    "powersystemresources.mrid",
]

UNIT_NOMINAL_PATHS = [
    "production_registeredresource.psrtype.powersystemresources.nominalp",
    "production_registeredresource.powersystemresources.nominalp",
    "powersystemresources.nominalp",
    "nominalp",
]

DOC_START_PATHS = [
    "unavailability_time_period.timeinterval.start",
    "unavailability_timeperiod.timeinterval.start",
    "unavailability_period.timeinterval.start",
    "timeperiod.timeinterval.start",
]

DOC_END_PATHS = [
    "unavailability_time_period.timeinterval.end",
    "unavailability_timeperiod.timeinterval.end",
    "unavailability_period.timeinterval.end",
    "timeperiod.timeinterval.end",
]

# Generation window requested by the frontend is 30 days; request it in
# parallel day chunks. Outage history is wider so that recent notices and
# planned returns are both visible.
DOWNLOAD_HEADERS = {
    "User-Agent": "chooz-meuse-dashboard/1.0 (local deployment)",
    "Accept": "application/xml, application/zip, text/plain, */*",
}

# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class UpstreamError(ApiError):
    def __init__(self, message: str, code: str = "upstream_error"):
        super().__init__(502, code, message)


# ---------------------------------------------------------------------------
# Small in-memory cache
# ---------------------------------------------------------------------------

_CACHE: dict[str, dict] = {}
_CACHE_LOCK = threading.Lock()


def cache_get(key: str):
    now = time.time()
    with _CACHE_LOCK:
        item = _CACHE.get(key)
        if not item:
            return None
        if item["expires"] <= now:
            _CACHE.pop(key, None)
            return None
        return item


def cache_put(key: str, status: int, payload: dict) -> None:
    with _CACHE_LOCK:
        if len(_CACHE) >= CONFIG["cache_max_entries"]:
            # Drop the entries that expire first; keeps the cache bounded.
            for old in sorted(_CACHE, key=lambda k: _CACHE[k]["expires"])[:8]:
                _CACHE.pop(old, None)
        _CACHE[key] = {
            "status": status,
            "payload": payload,
            "stored": time.time(),
            "expires": time.time() + CONFIG["cache_ttl_s"],
        }


# ---------------------------------------------------------------------------
# Upstream HTTP
# ---------------------------------------------------------------------------


def require_token() -> None:
    if not os.environ.get("ENTSOE_TOKEN", "").strip():
        raise ApiError(
            503,
            "missing_token",
            "Sunucuda ENTSOE_TOKEN tanimli degil. Backend'i token ile baslatin.",
        )


def http_get(params: dict, timeout: int | None = None, attempts: int | None = None) -> bytes:
    token = os.environ.get("ENTSOE_TOKEN", "").strip()
    if not token:
        raise ApiError(503, "missing_token", "ENTSOE_TOKEN tanimli degil.")

    timeout = CONFIG["request_timeout_s"] if timeout is None else max(5, timeout)
    attempts = CONFIG["retries"] if attempts is None else max(1, attempts)

    query = dict(params)
    query["securityToken"] = token
    url = CONFIG["api_url"] + "?" + urlencode(query, safe="")
    request = Request(url, headers=DOWNLOAD_HEADERS)

    last_error: UpstreamError | None = None
    for attempt in range(attempts):
        retry_after: float | None = None
        try:
            with urlopen(request, timeout=timeout) as response:
                return response.read()
        except HTTPError as err:
            body = b""
            try:
                body = err.read() or b""
            except Exception:
                pass
            low = body[:8192].lower()

            # Empty result sets are reported as 400/404 with this text.
            if err.code in (400, 404) and b"no matching data" in low:
                return b""
            if err.code in (401, 403):
                raise UpstreamError(
                    "ENTSO-E kimlik dogrulamasi basarisiz (HTTP %d). "
                    "ENTSOE_TOKEN degerini kontrol edin." % err.code,
                    "upstream_auth",
                )
            if err.code == 429:
                last_error = UpstreamError(
                    "ENTSO-E istek siniri asildi (HTTP 429).", "rate_limited"
                )
                retry_after = _retry_after_seconds(err)
            elif err.code >= 500:
                last_error = UpstreamError(
                    "ENTSO-E sunucu hatasi (HTTP %d)." % err.code
                )
            else:
                raise UpstreamError(
                    "ENTSO-E istegi reddedildi (HTTP %d)." % err.code
                )
        except (URLError, socket.timeout, TimeoutError) as err:
            reason = getattr(err, "reason", err)
            last_error = UpstreamError("ENTSO-E'ye ulasilamadi: %s" % reason)

        if attempt + 1 < attempts:
            delay = CONFIG["retry_backoff_s"] * (2 ** attempt)
            if retry_after:
                delay = max(delay, min(60.0, retry_after))
            time.sleep(delay)

    raise last_error or UpstreamError("ENTSO-E istegi basarisiz.")


def _retry_after_seconds(err) -> float | None:
    headers = getattr(err, "headers", None)
    if not headers:
        return None
    raw = (headers.get("Retry-After") or "").strip()
    if not raw:
        return None
    try:
        return max(0.0, float(raw))
    except ValueError:
        return None


def is_no_data(raw: bytes) -> bool:
    if not raw:
        return True
    return b"no matching data" in raw[:8192].lower()


def extract_documents(raw: bytes) -> list[bytes]:
    """Return one XML document per zip member, or the body itself if XML."""
    if is_no_data(raw):
        return []

    if raw[:2] == b"PK":
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                docs = []
                for info in archive.infolist():
                    if info.is_dir():
                        continue
                    data = archive.read(info)
                    if data.lstrip()[:1] == b"<":
                        docs.append(data)
                return docs
        except (zipfile.BadZipFile, OSError) as err:
            raise UpstreamError("ENTSO-E ZIP yaniti okunamadi: %s" % err)

    if raw.lstrip()[:1] == b"<":
        return [raw]
    return []


# ---------------------------------------------------------------------------
# XML helpers
# ---------------------------------------------------------------------------

_XMLNS_RE = re.compile(r'\sxmlns(:[\w.\-]+)?\s*=\s*"[^"]*"')
_PREFIX_RE = re.compile(r"<(/?)([\w.\-]+):")


def strip_namespaces(text: str) -> str:
    text = _XMLNS_RE.sub("", text)
    return _PREFIX_RE.sub(r"<\1", text)


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def parse_xml(raw: bytes):
    if not raw or is_no_data(raw):
        return None
    text = raw.decode("utf-8", "replace").lstrip("\ufeff")
    start = text.find("<")
    if start < 0:
        return None
    text = strip_namespaces(text[start:])
    try:
        return ET.fromstring(text)
    except ET.ParseError:
        return None


def collect(elem, prefix: str = "", out: dict | None = None) -> dict:
    """Flatten descendants into {dotted.path.lower(): text}, first value wins."""
    if out is None:
        out = {}
    for child in list(elem):
        name = local_name(child.tag)
        path = prefix + "." + name if prefix else name
        value = (child.text or "").strip()
        if value and path not in out:
            out[path] = value
        collect(child, path, out)
    return out


def pick(mapping: dict, keys: list[str]):
    for key in keys:
        value = mapping.get(key)
        if value:
            return value
    for key in keys:
        key = key.lower()
        for path, value in mapping.items():
            if value and (path == key or path.endswith("." + key)):
                return value
    return None


def direct_text(elem, name: str):
    wanted = name.lower()
    for child in list(elem):
        if local_name(child.tag) == wanted:
            return (child.text or "").strip()
    return None


def parse_datetime_ms(value):
    if not value:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    iso = raw.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(iso)
    except ValueError:
        dt = None
        for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
            try:
                dt = datetime.strptime(raw[:19], fmt)
                break
            except ValueError:
                continue
        if dt is None:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


_DURATION_RE = re.compile(r"^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$", re.IGNORECASE)


def duration_ms(value):
    if not value:
        return None
    match = _DURATION_RE.match(str(value).strip())
    if not match:
        return None
    days, hours, minutes = (int(x) if x else 0 for x in match.groups())
    total = ((days * 24 + hours) * 60 + minutes) * 60000
    return total or None


def to_float(value):
    if value is None:
        return None
    try:
        return float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return None


def normalize_unit_name(value: str) -> str:
    """Exact matching key: uppercase, letters/digits only (CHOOZ 1 -> CHOOZ1)."""
    return re.sub(r"[^A-Z0-9]", "", (value or "").upper())


def _unit_aliases(unit: dict) -> list[str]:
    names = unit.get("names") or []
    if isinstance(names, str):
        names = [names]
    aliases = [name for name in names if name]
    legacy = unit.get("normalized")
    if legacy and legacy not in aliases:
        aliases.append(legacy)
    return aliases


def _unit_alias_keys(unit: dict) -> set[str]:
    return {normalize_unit_name(alias) for alias in _unit_aliases(unit)}


UNIT_ALIAS_KEYS = {unit["key"]: _unit_alias_keys(unit) for unit in UNIT_DEFS}


def unit_names(mapping: dict) -> list[str]:
    names: list[str] = []
    for key in UNIT_NAME_PATHS:
        value = pick(mapping, [key])
        if value and value not in names:
            names.append(value)
    return names


def unit_eics(mapping: dict) -> list[str]:
    eics: list[str] = []
    for key in UNIT_EIC_PATHS:
        value = (pick(mapping, [key]) or "").strip().upper()
        if value and value not in eics:
            eics.append(value)
    return eics


def match_unit(names: list[str], eics, zone_key: str | None = None) -> str | None:
    """Exact EIC (registeredResource or powerSystemResources) or exact name."""
    if isinstance(eics, str) or eics is None:
        eics = [eics] if eics else []
    wanted_eics = {(eic or "").strip().upper() for eic in eics if (eic or "").strip()}

    if wanted_eics:
        for unit in UNIT_DEFS:
            if zone_key and unit["zoneKey"] != zone_key:
                continue
            expected = _env_text(unit["eic_env"]).upper()
            if expected and expected in wanted_eics:
                return unit["key"]

    for name in names:
        normalized = normalize_unit_name(name)
        for unit in UNIT_DEFS:
            if zone_key and unit["zoneKey"] != zone_key:
                continue
            if normalized in UNIT_ALIAS_KEYS[unit["key"]]:
                return unit["key"]
    return None


def matched_name(names: list[str]):
    for name in names:
        normalized = normalize_unit_name(name)
        for unit in UNIT_DEFS:
            if normalized in UNIT_ALIAS_KEYS[unit["key"]]:
                return name
    return None


def parse_period_blocks(container, tags=("period",)) -> list[dict]:
    """Extract TimeSeries/Period blocks with absolute timestamps."""
    blocks: list[dict] = []
    wanted = set(tags)

    for period in container.iter():
        if local_name(period.tag) not in wanted:
            continue

        meta = collect(period)
        start = parse_datetime_ms(pick(meta, ["timeinterval.start", "start"]))
        end = parse_datetime_ms(pick(meta, ["timeinterval.end", "end"]))
        resolution = duration_ms(pick(meta, ["resolution"]))

        raw_points = []
        for point in period.iter():
            if local_name(point.tag) != "point":
                continue
            pm = collect(point)
            quantity = to_float(pm.get("quantity"))
            if quantity is None:
                continue
            try:
                position = int(float(pm.get("position"))) if pm.get("position") else None
            except ValueError:
                position = None
            raw_points.append((position, quantity))

        if not raw_points:
            continue

        explicit = [p for p, _ in raw_points if p and p > 0]
        count = max(explicit) if explicit else len(raw_points)

        if resolution is None and start is not None and end is not None and count > 0:
            resolution = max(1, (end - start) // count)
        if resolution is None or start is None:
            continue

        points = []
        for index, (position, quantity) in enumerate(raw_points):
            pos = position if position and position > 0 else index + 1
            points.append([start + resolution * (pos - 1), quantity])

        blocks.append(
            {
                "start": start,
                "end": end,
                "resolutionMs": resolution,
                "points": points,
            }
        )

    return blocks


# ---------------------------------------------------------------------------
# Date helpers
# ---------------------------------------------------------------------------


def utc_today() -> datetime:
    return datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)


def parse_ymd(value: str) -> datetime:
    raw = (value or "").strip()[:10]
    try:
        return datetime.strptime(raw, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        raise ApiError(
            400, "bad_request", "'%s' gecersiz tarih; YYYY-MM-DD bekleniyor." % value
        )


def fmt_param(dt: datetime) -> str:
    return dt.strftime("%Y%m%d%H%M")


def parse_window(params, default_days: int, max_days: int, forward_days=None):
    raw_to = (params.get("to") or [""])[0].strip()
    raw_from = (params.get("from") or [""])[0].strip()

    if raw_to:
        to_dt = parse_ymd(raw_to)
    elif forward_days is not None:
        to_dt = utc_today() + timedelta(days=forward_days)
    else:
        to_dt = utc_today() + timedelta(days=1)

    if raw_from:
        from_dt = parse_ymd(raw_from)
    else:
        from_dt = to_dt - timedelta(days=default_days)

    if to_dt <= from_dt:
        raise ApiError(400, "bad_request", "'to' tarihi 'from' tarihinden sonra olmali.")

    span_days = (to_dt - from_dt).total_seconds() / 86400.0
    if span_days > max_days:
        raise ApiError(
            400,
            "bad_request",
            "Istenen aralik en fazla %d gun olabilir." % max_days,
        )

    return from_dt, to_dt


# ---------------------------------------------------------------------------
# Generation (A73)
# ---------------------------------------------------------------------------


# Day-level disk cache + background backfill. Each successful zone-day is
# stored in cache/generation/<ZONE>/YYYY-MM-DD.json and never downloaded again,
# except for today/yesterday and recent empty days (Belgian A73 can lag several
# days, so an empty recent day is retried hourly).
_GEN_LOCK = threading.RLock()
_GEN_DAY_MEM: dict[tuple[str, str], dict] = {}
_GEN_JOBS: dict[tuple[str, str], "Future"] = {}
_GEN_FAILED: dict[tuple[str, str], tuple[float, str]] = {}
_GEN_EXECUTOR = ThreadPoolExecutor(
    max_workers=CONFIG["generation_workers"], thread_name_prefix="a73"
)


def _day_key(day: datetime) -> str:
    return day.strftime("%Y-%m-%d")


def _day_start(key: str) -> datetime:
    return datetime.strptime(key, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def _day_path(zone_key: str, key: str) -> Path:
    return Path(CONFIG["generation_cache_dir"]) / zone_key / (key + ".json")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _read_day_from_disk(zone_key: str, key: str):
    path = _day_path(zone_key, key)
    if not path.is_file():
        return None
    try:
        record = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(record, dict) or record.get("version") != 3:
        return None
    if record.get("zone") != zone_key:
        return None
    if record.get("date") != key or not isinstance(record.get("units"), dict):
        return None
    return record


def _write_day_to_disk(zone_key: str, key: str, record: dict) -> None:
    path = _day_path(zone_key, key)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(record, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(tmp, path)
    except OSError as err:
        sys.stderr.write("[cache] %s/%s yazilamadi: %s\n" % (zone_key, key, err))


def _cached_day(zone_key: str, key: str):
    mem_key = (zone_key, key)
    with _GEN_LOCK:
        record = _GEN_DAY_MEM.get(mem_key)
    if record is not None:
        return record

    record = _read_day_from_disk(zone_key, key)
    if record is not None:
        with _GEN_LOCK:
            _GEN_DAY_MEM[mem_key] = record
    return record


def _day_is_fresh(key: str, record: dict, force: bool = False) -> bool:
    """Completed past days never expire; today/yesterday and recent empty days do."""
    try:
        day = _day_start(key)
    except ValueError:
        return False

    today = utc_today()
    fetched = record.get("fetchedAt") or 0

    # Belgian A73 is published with a multi-day lag. An empty recent day must be
    # retried periodically instead of being frozen as "no data" forever.
    if record.get("empty") and today - timedelta(days=7) <= day <= today:
        if force:
            return False
        return (_now_ms() - fetched) < 3600 * 1000

    if day < today - timedelta(days=1):
        return True

    # Future days have no A73 data yet; cache them so a window ending tomorrow
    # does not re-download an empty day on every request. They refresh normally
    # once the date rolls over to today.
    if day > today:
        return True

    if force:
        return False

    return (_now_ms() - fetched) < CONFIG["generation_refresh_s"] * 1000


_GEN_LOG_LOCK = threading.Lock()
_GEN_EIC_SEEN: set[tuple[str, str, str]] = set()


def _resolution_text(ms) -> str:
    if not ms:
        return "?"
    minutes = ms / 60000.0
    if minutes >= 60 and abs(minutes / 60 - round(minutes / 60)) < 1e-9:
        return "PT%dH" % round(minutes / 60)
    return "PT%sM" % ("%g" % minutes)


def _log_unit_series(zone_key, key, names, meta, blocks, role):
    """One line per matched unit TimeSeries in each fresh A73 fetch (no token)."""
    display = matched_name(names) or (names[0] if names else "?")
    registered = pick(meta, REGISTERED_RESOURCE_PATHS) or "-"
    psr = pick(meta, PSR_MRID_PATHS) or "-"
    in_domain = pick(meta, ["inbiddingzone_domain.mrid", "in_domain.mrid"]) or "-"
    out_domain = pick(meta, ["outbiddingzone_domain.mrid", "out_domain.mrid"]) or "-"
    resolutions = sorted({b["resolutionMs"] for b in blocks if b["resolutionMs"]})
    values = [value for block in blocks for _, value in block["points"]]
    lo = min(values) if values else None
    hi = max(values) if values else None

    print(
        "[A73 %s %s] %s %s | registeredResource=%s | powerSystemResources=%s | "
        "in=%s out=%s | res=%s | n=%d | min=%s max=%s"
        % (
            zone_key,
            key,
            display,
            role,
            registered,
            psr,
            in_domain,
            out_domain,
            "/".join(_resolution_text(r) for r in resolutions) or "?",
            len(values),
            "-" if lo is None else "%.2f" % lo,
            "-" if hi is None else "%.2f" % hi,
        ),
        flush=True,
    )

    eic_key = (zone_key, display, registered, psr)
    with _GEN_LOG_LOCK:
        first = eic_key not in _GEN_EIC_SEEN
        if first:
            _GEN_EIC_SEEN.add(eic_key)
    if first:
        print(
            "[A73 EIC %s] %s: registeredResource=%s powerSystemResources=%s"
            % (zone_key, display, registered, psr),
            flush=True,
        )


def _resample_points(series, base_resolution: int) -> dict[int, float]:
    """Return one rate per base interval; never mix 15- and 60-minute grids."""
    if not series:
        return {}
    resolution = series.get("resolutionMs") or 0
    points = series["points"]
    if resolution <= 0 or resolution == base_resolution:
        return dict(points)

    buckets: dict[int, list[float]] = {}
    for timestamp, value in points.items():
        bucket = timestamp - (timestamp % base_resolution)
        buckets.setdefault(bucket, []).append(float(value))
    return {
        timestamp: sum(values) / len(values)
        for timestamp, values in buckets.items()
    }


def parse_generation_day(zone_key: str, key: str, docs: list[bytes]) -> dict:
    zone_units = ZONE_UNITS[zone_key]
    units = {
        unit["key"]: {
            "name": None,
            "eic": None,
            "nominalMW": None,
            "series": {"generation": None, "consumption": None},
        }
        for unit in zone_units
    }
    sample_names: list[str] = []
    document_count = 0

    for raw in docs:
        root = parse_xml(raw)
        if root is None:
            continue
        document_count += 1

        for timeseries in root.iter():
            if local_name(timeseries.tag) != "timeseries":
                continue

            meta = collect(timeseries)
            names = unit_names(meta)
            eics = unit_eics(meta)
            hit = match_unit(names, eics, zone_key)

            for name in names:
                if name not in sample_names and len(sample_names) < 25:
                    sample_names.append(name)

            if hit is None:
                continue

            blocks = parse_period_blocks(timeseries, ("period",))
            if not blocks:
                continue

            in_domain = pick(meta, ["inbiddingzone_domain.mrid", "in_domain.mrid"])
            out_domain = pick(meta, ["outbiddingzone_domain.mrid", "out_domain.mrid"])

            # A73: inBiddingZone is the unit's generation, outBiddingZone is
            # its own consumption. A series carrying both is already net.
            if in_domain:
                role = "generation"
            elif out_domain:
                role = "consumption"
            else:
                role = "no-domain"

            _log_unit_series(zone_key, key, names, meta, blocks, role)
            if role == "no-domain":
                continue

            unit = units[hit]
            display = matched_name(names)
            if not unit["name"] and display:
                unit["name"] = display
            if not unit["eic"]:
                unit["eic"] = pick(meta, REGISTERED_RESOURCE_PATHS) or (
                    eics[0] if eics else None
                )
            if unit["nominalMW"] is None:
                unit["nominalMW"] = to_float(pick(meta, UNIT_NOMINAL_PATHS))

            resolutions = [b["resolutionMs"] for b in blocks if b["resolutionMs"]]
            if not resolutions:
                continue
            finest = min(resolutions)

            chosen: dict[int, float] = {}
            for block in blocks:
                if block["resolutionMs"] != finest:
                    continue
                for timestamp, value in block["points"]:
                    chosen.setdefault(timestamp, value)
            if not chosen:
                continue

            slot = unit["series"][role]
            if slot is None or finest < slot["resolutionMs"]:
                unit["series"][role] = {
                    "resolutionMs": finest,
                    "points": chosen,
                }
            elif finest == slot["resolutionMs"]:
                # Same role/resolution split across segments: keep one value per
                # timestamp, never add duplicate TimeSeries.
                for timestamp, value in chosen.items():
                    slot["points"].setdefault(timestamp, value)

    stored = {}
    for unit in zone_units:
        data = units[unit["key"]]
        generation = data["series"]["generation"]
        consumption = data["series"]["consumption"]

        resolutions = [
            series["resolutionMs"]
            for series in (generation, consumption)
            if series and series.get("resolutionMs")
        ]
        base_resolution = max(resolutions) if resolutions else None

        generation_points = (
            _resample_points(generation, base_resolution) if base_resolution else {}
        )
        consumption_points = (
            _resample_points(consumption, base_resolution) if base_resolution else {}
        )

        timestamps = set(generation_points) | set(consumption_points)
        points = []
        for timestamp in sorted(timestamps):
            generated = generation_points.get(timestamp, 0.0)
            consumed = consumption_points.get(timestamp, 0.0)
            net = generated - consumed
            points.append(
                [
                    timestamp,
                    round(net, 2),
                    round(generated, 2),
                    round(consumed, 2),
                ]
            )

        stored[unit["key"]] = {
            "name": data["name"],
            "eic": data["eic"],
            "nominalMW": data["nominalMW"],
            "resolutionMin": (
                int(round(base_resolution / 60000.0)) if base_resolution else None
            ),
            "count": len(points),
            "generationCount": len(generation["points"]) if generation else 0,
            "consumptionCount": len(consumption["points"]) if consumption else 0,
            "points": points,
        }

    return {
        "version": 3,
        "zone": zone_key,
        "date": key,
        "fetchedAt": _now_ms(),
        "documentCount": document_count,
        "sampleNames": sample_names,
        "units": stored,
        "empty": not any(record["count"] for record in stored.values()),
    }


def _download_generation_day(zone_key: str, key: str) -> dict:
    day = _day_start(key)
    raw = http_get(
        {
            "documentType": "A73",
            "processType": "A16",
            "in_Domain": ZONES[zone_key]["eic"],
            "periodStart": fmt_param(day),
            "periodEnd": fmt_param(day + timedelta(days=1)),
        },
        timeout=CONFIG["generation_timeout_s"],
        attempts=CONFIG["generation_attempts"],
    )

    record = parse_generation_day(zone_key, key, extract_documents(raw))
    _write_day_to_disk(zone_key, key, record)
    with _GEN_LOCK:
        _GEN_DAY_MEM[(zone_key, key)] = record
        _GEN_FAILED.pop((zone_key, key), None)
    return record


def fetch_aggregated_nuclear(zone_key: str) -> dict | None:
    """Fetch actual aggregated generation per production type (A75) for a zone.
    Returns the latest point as {value_mw, timestamp_ms, resolution_ms} or None."""
    if zone_key != "BE":
        return None
    try:
        now = datetime.now(timezone.utc)
        start = now - timedelta(days=1)
        end = now + timedelta(days=1)
        raw = http_get(
            {
                "documentType": "A75",
                "processType": "A16",
                "in_Domain": ZONES["BE"]["eic"],
                "psrType": "B14",  # Nuclear
                "periodStart": fmt_param(start),
                "periodEnd": fmt_param(end),
            },
            timeout=30,
            attempts=2,
        )
        docs = extract_documents(raw)
        for doc in docs:
            root = parse_xml(doc)
            if root is None:
                continue
            for timeseries in root.iter():
                if local_name(timeseries.tag) != "timeseries":
                    continue
                ts_meta = collect(timeseries)
                points = []
                for period in timeseries.iter():
                    if local_name(period.tag) != "period":
                        continue
                    p_meta = collect(period)
                    res_text = direct_text(period, "resolution")
                    resolution_ms = duration_ms(res_text) if res_text else None
                    for point in period.iter():
                        if local_name(point.tag) != "point":
                            continue
                        p_meta = collect(point)
                        pos = p_meta.get("position")
                        qty = p_meta.get("quantity")
                        if pos is not None and qty is not None:
                            try:
                                points.append((int(pos), float(qty)))
                            except ValueError:
                                pass
                if points:
                    points.sort(key=lambda x: x[0])
                    latest_pos, latest_val = points[-1]
                    period_start = parse_datetime_ms(p_meta.get("timeinterval.start"))
                    if period_start is not None and resolution_ms:
                        ts_ms = period_start + (latest_pos - 1) * resolution_ms
                    else:
                        ts_ms = int(time.time() * 1000)
                    return {
                        "value_mw": latest_val,
                        "timestamp_ms": ts_ms,
                        "resolution_ms": resolution_ms,
                    }
    except Exception as err:
        sys.stderr.write(f"[A75] Belgium nuclear fetch failed: {err}\n")
    return None


def _run_generation_job(zone_key: str, key: str) -> dict:
    try:
        return _download_generation_day(zone_key, key)
    except Exception as err:
        message = getattr(err, "message", None) or str(err)
        with _GEN_LOCK:
            _GEN_FAILED[(zone_key, key)] = (time.time(), message)
        raise


def _generation_job_done(zone_key: str, key: str, future) -> None:
    with _GEN_LOCK:
        if _GEN_JOBS.get((zone_key, key)) is future:
            _GEN_JOBS.pop((zone_key, key), None)


def _queue_generation_day(zone_key: str, key: str):
    """Return (future, failure_message); failure_message blocks retries briefly."""
    now = time.time()
    job_key = (zone_key, key)
    with _GEN_LOCK:
        failed = _GEN_FAILED.get(job_key)
        if failed and now - failed[0] < CONFIG["generation_failure_ttl_s"]:
            return None, failed[1]

        future = _GEN_JOBS.get(job_key)
        if future is None:
            future = _GEN_EXECUTOR.submit(_run_generation_job, zone_key, key)
            _GEN_JOBS[job_key] = future
            future.add_done_callback(
                lambda f, z=zone_key, k=key: _generation_job_done(z, k, f)
            )

    return future, None


def _generation_day_state(zone_key: str, key: str, force: bool):
    """Return ('ok', record), ('pending', None) or ('missing', message)."""
    record = _cached_day(zone_key, key)
    if record is not None and _day_is_fresh(key, record, force):
        return "ok", record

    future, failure = _queue_generation_day(zone_key, key)
    if record is not None:
        # Bugün/dün tazelenirken eski veri kaybolmasın: kullanılabilir kaydı
        # hemen döndür, yenileme arka planda sürsün.
        return "ok", record
    if failure:
        return "missing", failure

    if not future.done():
        return "pending", None

    try:
        return "ok", future.result()
    except Exception as err:
        return "missing", getattr(err, "message", None) or str(err)


def build_generation_payload(start: datetime, end: datetime, force: bool = False):
    """Assemble whatever zone-days are cached, queue the rest, never block."""
    keys = []
    cursor = start
    while cursor < end:
        keys.append(_day_key(cursor))
        cursor += timedelta(days=1)

    zone_records: dict[str, dict[str, dict]] = {zone: {} for zone in ZONES}
    pending_by_zone: dict[str, list[str]] = {zone: [] for zone in ZONES}
    missing_by_zone: dict[str, list[str]] = {zone: [] for zone in ZONES}
    pending: list[str] = []
    missing: list[str] = []
    failures: dict[str, str] = {}

    # Newest first across all zones: today's FR and BE requests are queued
    # before any older backfill day.
    pairs = [(zone_key, key) for zone_key in ZONES for key in keys]
    pairs.sort(key=lambda pair: (pair[1], pair[0]), reverse=True)

    for zone_key, key in pairs:
        label = "%s %s" % (zone_key, key)
        try:
            state, value = _generation_day_state(zone_key, key, force)
        except Exception as err:  # never fail the whole card for one day
            state, value = "missing", str(err)

        if state == "ok":
            zone_records[zone_key][key] = value
        elif state == "pending":
            pending.append(label)
            pending_by_zone[zone_key].append(key)
        else:
            missing.append(label)
            missing_by_zone[zone_key].append(key)
            failures[label] = value or "bilinmeyen hata"

    merged = {
        unit["key"]: {
            "key": unit["key"],
            "name": None,
            "eic": None,
            "nominalMW": None,
            "points": {},
            "resolutions": [],
        }
        for unit in UNIT_DEFS
    }

    sample_names: list[str] = []
    document_count = 0
    zone_summaries: dict[str, dict] = {}

    for zone_key, zone in ZONES.items():
        records = zone_records[zone_key]
        zone_doc_count = 0

        for key in sorted(records):
            record = records[key]
            zone_doc_count += record.get("documentCount") or 0
            for name in record.get("sampleNames") or []:
                if name not in sample_names and len(sample_names) < 25:
                    sample_names.append(name)

            for unit in ZONE_UNITS[zone_key]:
                src = (record.get("units") or {}).get(unit["key"]) or {}
                dst = merged[unit["key"]]
                if not dst["name"] and src.get("name"):
                    dst["name"] = src["name"]
                if not dst["eic"] and src.get("eic"):
                    dst["eic"] = src["eic"]
                if dst["nominalMW"] is None and src.get("nominalMW") is not None:
                    dst["nominalMW"] = src["nominalMW"]
                for point in src.get("points") or []:
                    dst["points"][point[0]] = point
                if src.get("resolutionMin"):
                    dst["resolutions"].append(src["resolutionMin"])

        document_count += zone_doc_count
        zone_summaries[zone_key] = {
            "key": zone_key,
            "eic": zone["eic"],
            "plants": list(zone["plants"]),
            "days": {
                "total": len(keys),
                "loaded": len(records),
                "pending": sorted(pending_by_zone[zone_key]),
                "missing": sorted(missing_by_zone[zone_key]),
            },
            "documentCount": zone_doc_count,
        }

    finalized = []
    for unit in UNIT_OVERVIEW:
        data = merged[unit["key"]]
        points = sorted(data["points"].items())
        resolutions = [r for r in data["resolutions"] if r]
        finalized.append(
            {
                "key": unit["key"],
                "name": data["name"] or unit["label"],
                "label": unit["label"],
                "eic": data["eic"],
                "nominalMW": data["nominalMW"],
                "resolutionMin": min(resolutions) if resolutions else None,
                "plantKey": unit["plantKey"],
                "plantLabel": unit["plantLabel"],
                "plantOrder": unit["plantOrder"],
                "country": unit["country"],
                "countryLabel": unit["countryLabel"],
                "zoneKey": unit["zoneKey"],
                "zoneEic": unit["zoneEic"],
                "overviewOrder": unit["overviewOrder"],
                "count": len(points),
                "points": [
                    [
                        t,
                        round(float(v[1]), 2),
                        round(float(v[2]), 2),
                        round(float(v[3]), 2),
                    ]
                    for t, v in points
                ],
            }
        )

    pending.sort()
    missing.sort()

    warnings: list[str] = []
    if missing:
        shown = ", ".join(missing[:8])
        if len(missing) > 8:
            shown += " …"
        warnings.append("%d zone-gun alinamadi: %s" % (len(missing), shown))

    has_data = any(record["count"] for record in finalized)
    if not has_data and not pending and not missing:
        expected = ", ".join(unit["label"] for unit in UNIT_OVERVIEW)
        warnings.append(
            "A73 yanitinda beklenen TimeSeries bulunamadi (%s). "
            "Birim adlari beklenenden farkli olabilir." % expected
        )

    return {
        "ok": True,
        # Kept for older clients; use "areas"/"zones" for the real mapping.
        "area": PLANTS[0]["zoneEic"],
        "areas": {zone_key: ZONES[zone_key]["eic"] for zone_key in ZONES},
        "plants": plants_public(),
        "zones": zone_summaries,
        "from": start.strftime("%Y-%m-%d"),
        "to": end.strftime("%Y-%m-%d"),
        "fromTs": int(start.timestamp() * 1000),
        "toTs": int(end.timestamp() * 1000),
        "fetchedAt": _now_ms(),
        "units": finalized,
        "days": {
            "total": len(pairs),
            "loaded": sum(len(records) for records in zone_records.values()),
            "pending": pending,
            "missing": missing,
        },
        "pending": pending,
        "missing": missing,
        "failures": failures,
        "complete": not pending and not missing,
        "warnings": warnings,
        "partial": bool(missing),
        "documentCount": document_count,
        "sampleNames": sample_names if not has_data else [],
    }


# ---------------------------------------------------------------------------
# Outages (A80 / A77)
# ---------------------------------------------------------------------------

OUTAGE_COMBOS = [
    ("A80", "A05"),
    ("A80", "A09"),
    ("A77", "A05"),
    ("A77", "A09"),
]


def fetch_outage_documents(zone_key: str, start: datetime, end: datetime):
    docs: list[bytes] = []
    errors: list[str] = []
    warnings: list[str] = []
    lock = threading.Lock()

    def work(combo):
        doc_type, doc_status = combo
        combo_docs: list[bytes] = []
        offset = 0
        for _page in range(CONFIG["outage_max_pages"]):
            raw = http_get(
                {
                    "documentType": doc_type,
                    "biddingZone_Domain": ZONES[zone_key]["eic"],
                    "periodStart": fmt_param(start),
                    "periodEnd": fmt_param(end),
                    "docStatus": doc_status,
                    "offset": offset,
                }
            )
            page_docs = extract_documents(raw)
            if not page_docs:
                break
            combo_docs.extend(page_docs)
            if len(page_docs) < CONFIG["outage_page_size"]:
                break
            offset += CONFIG["outage_page_size"]
        else:
            with lock:
                warnings.append(
                    "%s/%s %s bildirimleri %d sayfa ile sinirli; liste eksik olabilir."
                    % (zone_key, doc_type, doc_status, CONFIG["outage_max_pages"])
                )
        return combo_docs

    with ThreadPoolExecutor(max_workers=len(OUTAGE_COMBOS)) as pool:
        futures = {pool.submit(work, combo): combo for combo in OUTAGE_COMBOS}
        for future in as_completed(futures):
            try:
                docs.extend(future.result())
            except ApiError as err:
                if err.code in ("missing_token", "upstream_auth"):
                    for pending in futures:
                        pending.cancel()
                    raise
                errors.append(err.message)

    if errors and len(errors) == len(OUTAGE_COMBOS):
        raise UpstreamError(
            "ENTSO-E kesinti bildirimleri alinamadi: " + errors[0], "upstream_error"
        )

    return docs, errors, warnings


def outage_status_code(root) -> str | None:
    for child in list(root):
        if local_name(child.tag) == "docstatus":
            for item in child.iter():
                if local_name(item.tag) == "value":
                    value = (item.text or "").strip()
                    if value:
                        return value
    meta = collect(root)
    return pick(meta, ["docstatus.value"])


def parse_outage_document(
    raw: bytes, default_type: str, notices: dict, stats: dict, zone_key: str | None = None
) -> None:
    root = parse_xml(raw)
    if root is None:
        return

    meta = collect(root)

    document_mrid = direct_text(root, "mrid") or pick(meta, ["mrid"])
    if not document_mrid:
        document_mrid = "doc-" + hashlib.sha1(raw).hexdigest()[:16]

    revision_raw = direct_text(root, "revisionnumber") or pick(meta, ["revisionnumber"])
    try:
        revision = int(float(revision_raw)) if revision_raw else 0
    except ValueError:
        revision = 0

    created = parse_datetime_ms(
        direct_text(root, "createddatetime") or pick(meta, ["createddatetime"])
    )

    status_code = outage_status_code(root) or "A05"
    status = STATUS_LABELS.get(status_code, "unknown")

    doc_type = pick(meta, ["type"]) or default_type
    reason_code = pick(meta, ["reason.code"])
    reason_text = pick(meta, ["reason.text"])
    comment = pick(meta, ["comment"])

    doc_start = parse_datetime_ms(pick(meta, DOC_START_PATHS))
    doc_end = parse_datetime_ms(pick(meta, DOC_END_PATHS))

    for timeseries in root.iter():
        if local_name(timeseries.tag) != "timeseries":
            continue

        ts_meta = collect(timeseries)
        names = unit_names(ts_meta)
        eics = unit_eics(ts_meta)
        eic = eics[0] if eics else None
        unit_key = match_unit(names, eics, zone_key)

        # Reason/Comment usually sit on the document, but some TSOs repeat
        # them per TimeSeries. Accept both.
        ts_reason_code = pick(ts_meta, ["reason.code"])
        ts_reason_text = pick(ts_meta, ["reason.text"])
        ts_comment = pick(ts_meta, ["comment"])

        if unit_key is None:
            continue

        stats["matchedTimeseries"] += 1

        business = pick(ts_meta, ["businesstype"])
        kind = BUSINESS_LABELS.get(business or "", "unknown")
        nominal = to_float(pick(ts_meta, UNIT_NOMINAL_PATHS))

        blocks = parse_period_blocks(timeseries, ("available_period",))
        if not blocks:
            blocks = parse_period_blocks(timeseries, ("period",))

        available_values = []
        starts = []
        ends = []
        for block in blocks:
            if block["start"] is not None:
                starts.append(block["start"])
            if block["end"] is not None:
                ends.append(block["end"])
            for timestamp, value in block["points"]:
                available_values.append(value)
                starts.append(timestamp)

        ts_start = min(starts) if starts else doc_start
        ts_end = max(ends) if ends else doc_end
        if ts_end is None and blocks:
            last = max(
                (p[0] for block in blocks for p in block["points"]),
                default=None,
            )
            if last is not None:
                res = blocks[-1]["resolutionMs"] or 0
                ts_end = last + res

        if ts_start is None:
            ts_start = doc_start
        if ts_end is None:
            ts_end = doc_end

        available_mw = min(available_values) if available_values else None

        display = matched_name(names) or (names[0] if names else None)
        if not display:
            display = UNIT_BY_KEY[unit_key]["label"]
        unit_def = UNIT_BY_KEY[unit_key]

        record = {
            "id": document_mrid,
            "revision": revision,
            "status": status,
            "statusCode": status_code,
            "kind": kind,
            "businessType": business,
            "reasonCode": reason_code or ts_reason_code,
            "reason": REASON_LABELS.get((reason_code or ts_reason_code) or "", None),
            "reasonText": reason_text or ts_reason_text,
            "comment": comment or ts_comment,
            "unitKey": unit_key,
            "unitName": display,
            "unitLabel": unit_def["label"],
            "plantKey": unit_def["plantKey"],
            "plantLabel": unit_def["plantLabel"],
            "zoneKey": unit_def["zoneKey"],
            "eic": eic,
            "installedMW": nominal,
            "availableMW": available_mw,
            "start": ts_start,
            "end": ts_end,
            "created": created,
            "docType": doc_type,
        }

        dedupe_key = (document_mrid, unit_key or display.upper())
        previous = notices.get(dedupe_key)
        if previous is None:
            notices[dedupe_key] = record
        else:
            previous_rank = (previous.get("revision") or 0, previous.get("created") or 0)
            current_rank = (revision, created or 0)
            if current_rank >= previous_rank:
                notices[dedupe_key] = record


def build_outages_payload(start: datetime, end: datetime):
    notices: dict = {}
    stats = {"matchedTimeseries": 0}
    all_errors: list[str] = []
    warnings: list[str] = []
    zone_counts: dict[str, dict] = {}
    total_docs = 0
    zones_ok = 0

    # One outage query set per bidding zone (A80/A77 x active/cancelled).
    for zone_key in ZONES:
        try:
            docs, errors, zone_warnings = fetch_outage_documents(zone_key, start, end)
        except ApiError as err:
            if err.code in ("missing_token", "upstream_auth"):
                raise
            all_errors.append("%s: %s" % (zone_key, err.message))
            warnings.append("%s kesinti bildirimleri alinamadi." % zone_key)
            continue

        zones_ok += 1
        total_docs += len(docs)
        all_errors.extend(errors)
        warnings.extend(zone_warnings)

        before = stats["matchedTimeseries"]
        for raw in docs:
            parse_outage_document(raw, "A80", notices, stats, zone_key)
        zone_counts[zone_key] = {
            "key": zone_key,
            "eic": ZONES[zone_key]["eic"],
            "plants": list(ZONES[zone_key]["plants"]),
            "documents": len(docs),
            "matched": stats["matchedTimeseries"] - before,
        }

    if zones_ok == 0:
        raise UpstreamError(
            "ENTSO-E kesinti bildirimleri alinamadi: "
            + (all_errors[0] if all_errors else "bilinmeyen hata"),
            "upstream_error",
        )

    items = sorted(
        notices.values(),
        key=lambda item: (
            item.get("start") or 0,
            item.get("created") or 0,
        ),
        reverse=True,
    )

    counted = list(notices.values())
    active = sum(1 for item in counted if item.get("status") == "active")
    forced = sum(
        1
        for item in counted
        if item.get("status") == "active" and item.get("kind") == "forced"
    )

    if all_errors:
        warnings.append(
            "%d sorgu alinamadi; kalan bildirimler gosteriliyor." % len(all_errors)
        )

    fetched_at = int(time.time() * 1000)
    return {
        "ok": True,
        "area": PLANTS[0]["zoneEic"],
        "areas": {zone_key: ZONES[zone_key]["eic"] for zone_key in ZONES},
        "plants": plants_public(),
        "zones": zone_counts,
        "from": start.strftime("%Y-%m-%d"),
        "to": end.strftime("%Y-%m-%d"),
        "fromTs": int(start.timestamp() * 1000),
        "toTs": int(end.timestamp() * 1000),
        "fetchedAt": fetched_at,
        "notices": items,
        "counts": {
            "documents": total_docs,
            "matched": len(counted),
            "active": active,
            "activeForced": forced,
        },
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Endpoint handlers
# ---------------------------------------------------------------------------


def with_cache_meta(payload: dict, item: dict) -> dict:
    enriched = dict(payload)
    enriched["cached"] = True
    enriched["cacheAgeSeconds"] = int(time.time() - item["stored"])
    return enriched


def handle_generation(params):
    start, end = parse_window(
        params,
        default_days=CONFIG["default_generation_days"],
        max_days=CONFIG["max_generation_days"],
    )
    force = (params.get("force") or ["0"])[0].strip().lower() in ("1", "true", "yes")

    require_token()
    # Non-blocking: cached days are returned immediately, missing days are
    # downloaded in the background (2 workers) and picked up by the client's poll.
    return 200, build_generation_payload(start, end, force=force)


def handle_plants(_params):
    return 200, {
        "ok": True,
        "plants": plants_public(),
        "zones": [
            {
                "key": zone_key,
                "eic": ZONES[zone_key]["eic"],
                "plants": list(ZONES[zone_key]["plants"]),
                "units": list(ZONES[zone_key]["units"]),
            }
            for zone_key in ZONES
        ],
        "overviewOrder": [unit["key"] for unit in UNIT_OVERVIEW],
        "now": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def handle_aggregated_generation(params):
    """Fetch actual aggregated generation per production type (A75) for Belgium."""
    zone_key = (params.get("zone") or ["BE"])[0].strip().upper()
    if zone_key != "BE":
        return 400, {"ok": False, "error": {"code": "invalid_zone", "message": "Only BE is supported for A75"}}
    key = "aggregated|v1|%s" % zone_key
    cached = cache_get(key)
    if cached:
        return cached["status"], with_cache_meta(cached["payload"], cached)
    require_token()
    data = fetch_aggregated_nuclear(zone_key)
    if data is None:
        return 404, {"ok": False, "error": {"code": "no_data", "message": "No aggregated nuclear data available"}}
    payload = {"ok": True, "zone": zone_key, "data": data, "cached": False}
    cache_put(key, 200, payload)
    return 200, payload


def handle_outages(params):
    start, end = parse_window(
        params,
        default_days=CONFIG["default_outage_back_days"],
        max_days=CONFIG["max_outage_days"],
        forward_days=CONFIG["default_outage_forward_days"],
    )
    key = "outages|v3|%s|%s|%s" % (
        ",".join(sorted(ZONES)),
        start.strftime("%Y-%m-%d"),
        end.strftime("%Y-%m-%d"),
    )

    cached = cache_get(key)
    if cached:
        return cached["status"], with_cache_meta(cached["payload"], cached)

    require_token()
    payload = build_outages_payload(start, end)
    payload["cached"] = False
    cache_put(key, 200, payload)
    return 200, payload


def handle_health(_params):
    return 200, {
        "ok": True,
        "service": "chooz-entsoe-proxy",
        "area": PLANTS[0]["zoneEic"],
        "areas": {zone_key: ZONES[zone_key]["eic"] for zone_key in ZONES},
        "plants": [plant["key"] for plant in PLANTS],
        "tokenConfigured": bool(os.environ.get("ENTSOE_TOKEN", "").strip()),
        "cacheTtlSeconds": CONFIG["cache_ttl_s"],
        "now": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "ChoozDashboard/1.0"
    protocol_version = "HTTP/1.1"

    # -- helpers ---------------------------------------------------------

    def _cors(self):
        origin = (self.headers.get("Origin") or "").strip()
        allowed = CONFIG.get("allowed_origins") or []
        if not origin or origin not in allowed:
            return
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
        self.send_header("Access-Control-Max-Age", "86400")

    def send_json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status: int, code: str, message: str):
        self.send_json(status, {"ok": False, "error": {"code": code, "message": message}})

    # -- verbs -----------------------------------------------------------

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    def do_HEAD(self):
        self._serve(head_only=True)

    def do_GET(self):
        self._serve(head_only=False)

    def _serve(self, head_only: bool):
        try:
            parts = urlsplit(self.path)
            path = unquote(parts.path)
            params = parse_qs(parts.query)

            if path.startswith("/api/entsoe/"):
                status, payload = self._route_api(path, params)
                if head_only:
                    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Cache-Control", "no-store")
                    self._cors()
                    self.end_headers()
                else:
                    self.send_json(status, payload)
                return

            self._serve_static(path, head_only)

        except ApiError as err:
            self.send_error_json(err.status, err.code, err.message)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError) as err:
            self.close_connection = True
            sys.stderr.write(
                "[http] istemci baglantisi kesildi (%s)\n" % type(err).__name__
            )
        except Exception:
            traceback.print_exc()
            self.send_error_json(500, "internal_error", "Sunucu hatasi.")

    def _route_api(self, path: str, params):
        if path == "/api/entsoe/health":
            return handle_health(params)
        if path == "/api/entsoe/generation":
            return handle_generation(params)
        if path == "/api/entsoe/plants":
            return handle_plants(params)
        if path == "/api/entsoe/outages":
            return handle_outages(params)
        if path == "/api/entsoe/aggregated-generation":
            return handle_aggregated_generation(params)
        raise ApiError(404, "not_found", "Bilinmeyen API yolu.")

    def _serve_static(self, path: str, head_only: bool):
        relative = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (BASE_DIR / relative).resolve()

        try:
            target.relative_to(BASE_DIR)
        except ValueError:
            self.send_error_json(403, "forbidden", "Erisim reddedildi.")
            return

        if target.is_dir():
            target = target / "index.html"

        if not target.is_file():
            self.send_error_json(404, "not_found", "Dosya bulunamadi.")
            return

        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in (
            "application/javascript",
            "application/json",
            "image/svg+xml",
        ):
            ctype += "; charset=utf-8"

        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self._cors()
        self.end_headers()
        if not head_only:
            self.wfile.write(data)

    def log_message(self, fmt, *args):
        sys.stderr.write(
            "[%s] %s - %s\n" % (time.strftime("%H:%M:%S"), self.address_string(), fmt % args)
        )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> int:
    token_ready = bool(os.environ.get("ENTSOE_TOKEN", "").strip())

    print("Chooz / Meuse dashboard")
    print("  ENTSOE_TOKEN: %s" % ("configured" if token_ready else "MISSING"))
    for plant in PLANTS:
        units = ", ".join(
            "%s (%s)" % (unit["label"], _env_text(unit["eic_env"]).upper() or "name")
            for unit in plant["units"]
        )
        print(
            "  Plant:        %-8s %s / %s zone %s | units: %s"
            % (
                plant["label"],
                plant["country"],
                plant["countryLabel"],
                plant["zoneEic"],
                units,
            )
        )
    print("  Cache TTL:    %d s" % CONFIG["cache_ttl_s"])
    print("  Serving:      %s" % BASE_DIR)
    print("  URL:          http://127.0.0.1:%d/" % CONFIG["port"])
    if not token_ready:
        print("")
        print("  UYARI: ENTSOE_TOKEN tanimli degil; sadece Hub'Eau verisi calisir.")
        print("  PowerShell:  $env:ENTSOE_TOKEN = \"<token>\"")
        print("")

    try:
        server = ThreadingHTTPServer((CONFIG["host"], CONFIG["port"]), DashboardHandler)
    except OSError as err:
        print("Sunucu baslatilamadi (port %d): %s" % (CONFIG["port"], err), file=sys.stderr)
        return 1

    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nKapatiliyor...")
    finally:
        server.server_close()
        # A73 workers can sit in a 120 s upstream call; do not let them hold
        # the interpreter open after Ctrl+C.
        try:
            _GEN_EXECUTOR.shutdown(wait=False, cancel_futures=True)
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
