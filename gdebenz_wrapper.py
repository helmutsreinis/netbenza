#!/usr/bin/env python3
"""
GdeBenz.ru API Wrapper — bulk voting on gas stations with fuel filtering.

Discovered APIs:
  GET  /api/cfg                    — service config (live, features)
  GET  /api/rt                     — real-time token (X-RT header)
  GET  /api/vt                     — vote token for comment submission
  GET  /api/nearby?lat=&lon=&radius_km=  — nearby stations + summary
  GET  /api/stations?lat1=&lon1=&lat2=&lon2= — stations in bounding box
  GET  /api/comments/{osm_id}      — station details + cvt token
  POST /api/comments               — submit vote/comment
  GET  /api/search?q=              — search stations/cities
  GET  /api/cities?q=              — city search
  GET  /api/geoip                  — geoip lookup
  GET  /api/thanks?osm_id=...      — thank a station
  GET  /api/thanks/mine?fp=...     — my thanks
  POST /api/station-suggestions    — suggest new station
  POST /api/station-suggestions/check — check before suggesting
  POST /api/station-suggestions/mine  — my suggestions
  POST /api/station-suggestions/resolve — resolve link → coords
  POST /api/station-not-here       — report station not here
  GET  /api/reverse-city?lat=&lon= — reverse geocode
  GET  /api/views?ids=             — view tracking

Fuel grades: 92, 95, 98, 100, ДТ (diesel)
Vote statuses: yes (has fuel), queue (queue), low (limited), no (no fuel)

Usage:
  python3 gdebenz_wrapper.py list --lat 55.75 --lon 37.62 --radius 20 --fuel 95,ДТ
  python3 gdebenz_wrapper.py list --city Москва --fuel 92,95 --status yes
  python3 gdebenz_wrapper.py vote --city Москва --status no --vote yes --text "есть 95"
  python3 gdebenz_wrapper.py vote --dry-run --city Москва --status no
  python3 gdebenz_wrapper.py serve --port 8080              # web UI on local network
  python3 gdebenz_wrapper.py serve --city Москва --port 8080
"""

import argparse
import json
import os
import random
import sys
import time
import uuid
from dataclasses import dataclass
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Optional
from urllib.parse import urlparse, parse_qs

import requests

BASE_URL = "https://gdebenz.ru"
FUEL_GRADES = ["92", "95", "98", "100", "ДТ"]
STATUSES = ["yes", "queue", "low", "no"]
STATUS_LABELS = {
    "yes": "Есть топливо",
    "queue": "Очередь",
    "low": "Мало топлива",
    "no": "Нет топлива",
}
STATUS_COLORS = {
    "yes": "#22C55E",
    "queue": "#FF7A1A",
    "low": "#FFC400",
    "no": "#FF4D5A",
    "none": "#8A94A6",
}

TOKEN_CACHE = {}


def _cache_get(key: str) -> Optional[str]:
    entry = TOKEN_CACHE.get(key)
    if entry and time.time() < entry["expires"]:
        return entry["value"]
    return None


def _cache_set(key: str, value: str, ttl: int = 1800):
    TOKEN_CACHE[key] = {"value": value, "expires": time.time() + ttl - 60}


@dataclass
class Station:
    osm_id: str
    name: str
    brand: str
    addr: str
    lat: float
    lon: float
    status: str
    fuels_now: str
    confirmations: int = 0
    confirmed: bool = False
    last_at: str = ""
    distance_km: float = 0.0
    conflict: str = ""
    confidence_base: float = 0.0

    @property
    def fuel_list(self) -> list[str]:
        return [f.strip() for f in self.fuels_now.split(",") if f.strip()]

    @property
    def status_label(self) -> str:
        return STATUS_LABELS.get(self.status, self.status)

    def has_fuel(self, fuel_type: str) -> bool:
        return fuel_type in self.fuel_list

    def to_dict(self) -> dict:
        return {
            "osm_id": self.osm_id,
            "name": self.name,
            "brand": self.brand,
            "addr": self.addr,
            "lat": self.lat,
            "lon": self.lon,
            "status": self.status,
            "status_label": self.status_label,
            "status_color": STATUS_COLORS.get(self.status, STATUS_COLORS["none"]),
            "fuels_now": self.fuels_now,
            "fuel_list": self.fuel_list,
            "confirmations": self.confirmations,
            "confirmed": self.confirmed,
            "last_at": self.last_at,
            "distance_km": self.distance_km,
            "conflict": self.conflict,
            "confidence_base": self.confidence_base,
        }


class GdebenzAPI:
    """Low-level API client for gdebenz.ru."""

    def __init__(
        self,
        fingerprint: Optional[str] = None,
        session: Optional[requests.Session] = None,
    ):
        self._fp = fingerprint or self._generate_fp()
        self._session = session or requests.Session()
        self._session.headers.update({
            "User-Agent": "gdebenz-wrapper/1.0",
            "Accept": "application/json",
        })

    @staticmethod
    def _generate_fp() -> str:
        return uuid.uuid4().hex

    @property
    def fingerprint(self) -> str:
        return self._fp

    def _get_rt(self) -> str:
        cached = _cache_get("rt")
        if cached:
            return cached
        try:
            resp = self._session.get(f"{BASE_URL}/api/rt", timeout=10)
            resp.raise_for_status()
            data = resp.json()
            token = data.get("rt", "")
            ttl = data.get("ttl", 1800)
            _cache_set("rt", token, ttl)
            return token
        except Exception:
            return ""

    def _get_vt(self) -> str:
        cached = _cache_get("vt")
        if cached:
            return cached
        try:
            resp = self._session.get(f"{BASE_URL}/api/vt", timeout=10)
            resp.raise_for_status()
            data = resp.json()
            token = data.get("vt", "")
            ttl = data.get("ttl", 1800)
            _cache_set("vt", token, ttl)
            return token
        except Exception:
            return ""

    def _get_cvt(self, osm_id: str) -> str:
        try:
            resp = self._session.get(
                f"{BASE_URL}/api/comments/{osm_id}",
                headers={"X-RT": self._get_rt()},
                timeout=10,
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("cvt", "")
        except Exception:
            return ""

    def get_config(self) -> dict:
        resp = self._session.get(f"{BASE_URL}/api/cfg", timeout=10)
        resp.raise_for_status()
        return resp.json()

    def geoip(self) -> dict:
        resp = self._session.get(f"{BASE_URL}/api/geoip", timeout=10)
        resp.raise_for_status()
        return resp.json()

    def search_city(self, query: str) -> list[dict]:
        resp = self._session.get(
            f"{BASE_URL}/api/cities",
            params={"q": query},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, dict) and "results" in data:
            return data["results"]
        if isinstance(data, list):
            return data
        return []

    def reverse_city(self, lat: float, lon: float) -> str:
        resp = self._session.get(
            f"{BASE_URL}/api/reverse-city",
            params={"lat": f"{lat:.2f}", "lon": f"{lon:.2f}"},
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json().get("city", "")

    def get_nearby(
        self, lat: float, lon: float, radius_km: float = 20
    ) -> tuple[list[Station], dict]:
        lat_snapped = round(lat * 20) / 20
        lon_snapped = round(lon * 20) / 20

        resp = self._session.get(
            f"{BASE_URL}/api/nearby",
            params={
                "lat": f"{lat_snapped:.2f}",
                "lon": f"{lon_snapped:.2f}",
                "radius_km": radius_km,
            },
            headers={"X-RT": self._get_rt()},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        stations = [_parse_station(s) for s in data.get("stations", [])]
        summary = data.get("summary", {})
        return stations, summary

    def get_stations(
        self, lat1: float, lon1: float, lat2: float, lon2: float
    ) -> list[Station]:
        resp = self._session.get(
            f"{BASE_URL}/api/stations",
            params={
                "lat1": f"{lat1:.2f}",
                "lon1": f"{lon1:.2f}",
                "lat2": f"{lat2:.2f}",
                "lon2": f"{lon2:.2f}",
            },
            headers={"X-RT": self._get_rt()},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        if not isinstance(data, list):
            return []
        return [_parse_station(s) for s in data]

    def get_station_comments(self, osm_id: str) -> dict:
        resp = self._session.get(
            f"{BASE_URL}/api/comments/{osm_id}",
            headers={"X-RT": self._get_rt()},
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json()

    def vote(
        self,
        osm_id: str,
        status: str,
        name: str = "",
        lat: float = 0,
        lon: float = 0,
        text: str = "",
        vlat: float = 0,
        vlon: float = 0,
        on_site: bool = False,
    ) -> dict:
        if status not in STATUSES:
            raise ValueError(
                f"Invalid status '{status}'. Must be one of {STATUSES}"
            )

        vt = self._get_vt()
        cvt = self._get_cvt(osm_id)

        if on_site:
            vlat = lat
            vlon = lon

        body = {
            "osm_id": osm_id,
            "name": name,
            "lat": lat,
            "lon": lon,
            "status": status,
            "text": text,
            "fp": self._fp,
            "cf": "",
            "vt": vt,
        }
        if cvt:
            body["cvt"] = cvt
        if vlat and vlon:
            body["vlat"] = vlat
            body["vlon"] = vlon

        resp = self._session.post(
            f"{BASE_URL}/api/comments",
            json=body,
            headers={
                "Content-Type": "application/json",
                "X-RT": self._get_rt(),
            },
            timeout=15,
        )

        if resp.status_code == 409:
            detail = ""
            try:
                detail = resp.json().get("detail", "")
            except Exception:
                pass
            return {"success": False, "reason": detail or "already voted"}

        if resp.status_code == 403:
            return {"success": False, "reason": "forbidden"}

        resp.raise_for_status()
        return {"success": True, "data": resp.json()}


def _parse_station(raw: dict) -> Station:
    return Station(
        osm_id=str(raw.get("osm_id", "")),
        name=raw.get("name", "") or raw.get("brand", "") or "Заправка",
        brand=raw.get("brand", "") or "",
        addr=raw.get("addr", "") or "",
        lat=float(raw.get("lat", 0)),
        lon=float(raw.get("lon", 0)),
        status=raw.get("status", "none"),
        fuels_now=raw.get("fuels_now", ""),
        confirmations=int(raw.get("confirmations", 0)),
        confirmed=bool(raw.get("confirmed", False)),
        last_at=raw.get("last_at", ""),
        distance_km=float(raw.get("distance_km", 0)),
        conflict=raw.get("conflict", ""),
        confidence_base=float(raw.get("confidence_base", 0)),
    )


def filter_stations(
    stations: list[Station],
    fuel_types: list[str] | None = None,
    statuses: list[str] | None = None,
    min_confirmations: int = 0,
    brand: str | None = None,
) -> list[Station]:
    result = stations
    if statuses:
        result = [s for s in result if s.status in statuses]
    if fuel_types:
        result = [
            s
            for s in result
            if any(ft in s.fuel_list for ft in fuel_types)
        ]
    if min_confirmations > 0:
        result = [s for s in result if s.confirmations >= min_confirmations]
    if brand:
        brand_lower = brand.lower()
        result = [
            s
            for s in result
            if brand_lower in s.brand.lower()
            or brand_lower in s.name.lower()
        ]
    return result


def resolve_coords(
    api: GdebenzAPI,
    city: Optional[str] = None,
    lat: Optional[float] = None,
    lon: Optional[float] = None,
) -> tuple[float, float]:
    if lat is not None and lon is not None:
        return lat, lon
    if city:
        cities = api.search_city(city)
        if cities:
            c = cities[0]
            return float(c.get("lat", 0)), float(c.get("lon", 0))
        raise ValueError(f"City '{city}' not found")
    geo = api.geoip()
    return float(geo.get("lat", 55.75)), float(geo.get("lon", 37.62))


def print_station(s: Station, idx: Optional[int] = None):
    prefix = f"[{idx}] " if idx is not None else ""
    fuels = f" [{s.fuels_now}]" if s.fuels_now else ""
    dist = f" ({s.distance_km:.1f}км)" if s.distance_km else ""
    conf = f" ✓{s.confirmations}" if s.confirmations else ""
    print(f"  {prefix}{s.name} — {s.status_label}{fuels}{dist}{conf}")
    if s.addr:
        print(f"      {s.addr}")
    print(f"      osm_id={s.osm_id}")


# ─────────────────────────────────────────────────────────────────────
# CLI COMMANDS
# ─────────────────────────────────────────────────────────────────────


def cmd_list(args, api: GdebenzAPI):
    lat, lon = resolve_coords(api, city=args.city, lat=args.lat, lon=args.lon)

    if args.bounding_box:
        parts = args.bounding_box.split(",")
        lat1, lon1, lat2, lon2 = map(float, parts)
        stations = api.get_stations(lat1, lon1, lat2, lon2)
    else:
        radius = args.radius or 20
        stations, summary = api.get_nearby(lat, lon, radius)
        print(f"📍 Центр: {lat:.4f}, {lon:.4f} (радиус {radius}км)")
        print(
            f"   Всего: {summary.get('yes', 0)} есть / "
            f"{summary.get('queue', 0)} очередь / "
            f"{summary.get('low', 0)} мало / "
            f"{summary.get('no', 0)} нет"
        )

    fuel_types = (
        [f.strip() for f in args.fuel.split(",")] if args.fuel else None
    )
    statuses = (
        [s.strip() for s in args.status.split(",")] if args.status else None
    )

    filtered = filter_stations(
        stations,
        fuel_types=fuel_types,
        statuses=statuses,
        min_confirmations=args.min_confirmations or 0,
        brand=args.brand,
    )

    print(f"\n🔍 Отфильтровано: {len(filtered)} из {len(stations)} АЗС")
    if args.fuel:
        print(f"   Топливо: {fuel_types}")
    if args.status:
        print(f"   Статус: {statuses}")
    print()

    limit = args.limit or len(filtered)
    for i, s in enumerate(filtered[:limit]):
        print_station(s, idx=i + 1)

    if limit < len(filtered):
        print(f"\n  ... и ещё {len(filtered) - limit}")


def cmd_vote(args, api: GdebenzAPI):
    if not args.vote_status:
        print("❌ Укажите --vote-status (yes/queue/low/no)")
        sys.exit(1)
    if args.vote_status not in STATUSES:
        print(
            f"❌ Недопустимый статус: {args.vote_status}. "
            f"Допустимые: {STATUSES}"
        )
        sys.exit(1)

    lat, lon = resolve_coords(
        api, city=args.city, lat=args.lat, lon=args.lon
    )

    if args.bounding_box:
        parts = args.bounding_box.split(",")
        lat1, lon1, lat2, lon2 = map(float, parts)
        stations = api.get_stations(lat1, lon1, lat2, lon2)
    else:
        radius = args.radius or 20
        stations, summary = api.get_nearby(lat, lon, radius)
        print(f"📍 Центр: {lat:.4f}, {lon:.4f} (радиус {radius}км)")

    fuel_types = (
        [f.strip() for f in args.fuel.split(",")] if args.fuel else None
    )
    statuses = (
        [s.strip() for s in args.status.split(",")] if args.status else None
    )
    filtered = filter_stations(
        stations,
        fuel_types=fuel_types,
        statuses=statuses,
        min_confirmations=args.min_confirmations or 0,
        brand=args.brand,
    )

    limit = args.limit or len(filtered)
    targets = filtered[:limit]

    print(f"\n🎯 Голосуем за {len(targets)} из {len(stations)} АЗС")
    print(
        f"   Новый статус: "
        f"{STATUS_LABELS.get(args.vote_status, args.vote_status)}"
    )
    if args.text:
        print(f"   Комментарий: {args.text}")

    if args.dry_run:
        print("\n🏁 DRY RUN — голоса НЕ отправляются:\n")
        for i, s in enumerate(targets):
            print_station(s, idx=i + 1)
        print(f"\n   Будет проголосовано: {len(targets)} АЗС")
        return

    if not args.yes:
        print(
            f"\nБудет отправлено {len(targets)} голосов. Продолжить? [y/N]: ",
            end="",
        )
        if input().strip().lower() != "y":
            print("Отменено.")
            return

    print()
    success = 0
    failed = 0
    skipped = 0

    for i, s in enumerate(targets):
        voter_lat = lat if args.on_site else 0
        voter_lon = lon if args.on_site else 0
        label = f"[{i + 1}/{len(targets)}] {s.name}"

        try:
            result = api.vote(
                osm_id=s.osm_id,
                status=args.vote_status,
                name=s.name,
                lat=s.lat,
                lon=s.lon,
                text=args.text or "",
                vlat=voter_lat,
                vlon=voter_lon,
                on_site=args.on_site,
            )

            if result.get("success"):
                print(f"  ✅ {label} — OK")
                success += 1
            else:
                reason = result.get("reason", "unknown")
                print(f"  ⚠️  {label} — {reason}")
                if "cooldown" in reason or "already" in reason.lower():
                    skipped += 1
                else:
                    failed += 1
        except Exception as e:
            print(f"  ❌ {label} — ошибка: {e}")
            failed += 1

        if i < len(targets) - 1:
            time.sleep(0.3 + random.random() * 0.4)

    print(
        f"\n📊 Итого: {success} успешно, "
        f"{skipped} пропущено, {failed} ошибок"
    )


# ─────────────────────────────────────────────────────────────────────
# WEB SERVER
# ─────────────────────────────────────────────────────────────────────

HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ГдеБЕНЗ — карта АЗС</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;height:100vh;display:flex}
#map{flex:1;min-height:100vh}
#sidebar{width:380px;background:#1e293b;display:flex;flex-direction:column;overflow-y:auto;border-left:1px solid #334155}
.sidebar-header{padding:16px;background:#0f172a;border-bottom:1px solid #334155}
.sidebar-header h1{font-size:18px;color:#22C55E}
.sidebar-header .sub{font-size:12px;color:#94a3b8;margin-top:2px}
.section{padding:12px 16px;border-bottom:1px solid #334155}
.section-title{font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;margin-bottom:8px;letter-spacing:.5px}
.search-row{display:flex;gap:6px}
.search-row input{flex:1;padding:8px 12px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:14px;outline:none}
.search-row input:focus{border-color:#22C55E}
.search-row button,.btn{padding:8px 14px;background:#22C55E;color:#000;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;transition:background .15s}
.search-row button:hover,.btn:hover{background:#16a34a}
.btn-outline{padding:8px 14px;background:transparent;color:#22C55E;border:1px solid #22C55E;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px}
.btn-outline:hover{background:#22C55E20}
.btn-danger{padding:8px 14px;background:#DC2626;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px}
.btn-danger:hover{background:#b91c1c}
.chip-group{display:flex;flex-wrap:wrap;gap:6px}
.chip{padding:5px 12px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid #475569;background:#0f172a;color:#94a3b8;transition:all .15s;user-select:none}
.chip.on{background:#22C55E;color:#000;border-color:#22C55E}
.chip.status-no{--c:#FF4D5A}
.chip.status-queue{--c:#FF7A1A}
.chip.status-low{--c:#FFC400}
.chip.status-yes{--c:#22C55E}
.chip.status-on{background:var(--c);color:#000;border-color:var(--c)}
.coords-row{display:flex;gap:6px;align-items:center}
.coords-row input{width:90px;padding:6px 8px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px;outline:none}
.coords-row input:focus{border-color:#22C55E}
.coords-row span{color:#94a3b8;font-size:13px}
#summary{font-size:12px;color:#94a3b8;padding:8px 16px}
#summary b{color:#e2e8f0}
#station-list{flex:1;overflow-y:auto}
.station-card{padding:12px 16px;border-bottom:1px solid #334155;cursor:pointer;transition:background .1s}
.station-card:hover{background:#33415540}
.station-card.selected{background:#22C55E15;border-left:3px solid #22C55E}
.station-card .name{font-size:14px;font-weight:600}
.station-card .addr{font-size:12px;color:#94a3b8;margin-top:2px}
.station-card .meta{font-size:12px;color:#94a3b8;margin-top:4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.station-card .fuel-tag{display:inline-block;padding:1px 6px;background:#334155;border-radius:4px;font-size:11px;font-weight:600;color:#e2e8f0}
.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%}
#vote-bar{position:sticky;bottom:0;background:#0f172a;padding:12px 16px;border-top:1px solid #334155;display:none}
#vote-bar.show{display:block}
#vote-bar .count{font-size:14px;margin-bottom:8px}
#vote-bar .count b{color:#22C55E}
#vote-bar .vote-btns{display:flex;gap:6px;flex-wrap:wrap}
.vote-btn{padding:8px 16px;border-radius:8px;border:2px solid transparent;cursor:pointer;font-weight:700;font-size:13px;transition:all .15s}
.vote-btn:hover{opacity:.85}
.vote-btn.yes{background:#22C55E;color:#000}
.vote-btn.queue{background:#FF7A1A;color:#000}
.vote-btn.low{background:#FFC400;color:#000}
.vote-btn.no{background:#FF4D5A;color:#fff}
#toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1e293b;color:#e2e8f0;padding:10px 20px;border-radius:8px;font-size:14px;z-index:9999;opacity:0;transition:opacity .3s;pointer-events:none;border:1px solid #334155}
#toast.show{opacity:1}
#toast.error{border-color:#FF4D5A}
#toast.success{border-color:#22C55E}
.leaflet-popup-content-wrapper{background:#1e293b;color:#e2e8f0;border-radius:8px}
.leaflet-popup-tip{background:#1e293b}
.leaflet-popup-content{font-size:13px;margin:8px 12px}
.popup-name{font-weight:700;font-size:14px}
.popup-addr{color:#94a3b8;font-size:12px;margin-top:2px}
.popup-meta{margin-top:6px;font-size:12px}
.popup-vote{margin-top:8px;display:flex;gap:4px}
.popup-vote button{padding:3px 8px;border-radius:4px;border:none;cursor:pointer;font-size:11px;font-weight:600}
@media(max-width:768px){#sidebar{width:100%;position:absolute;top:0;left:0;right:0;bottom:40%;z-index:1000;border-radius:0}#map{height:60vh}}
</style>
</head>
<body>
<div id="map"></div>
<div id="sidebar">
  <div class="sidebar-header">
    <h1>⛽ ГдеБЕНЗ</h1>
    <div class="sub">Карта АЗС — отметки водителей в реальном времени</div>
  </div>

  <div class="section">
    <div class="section-title">🔍 Поиск города</div>
    <div class="search-row">
      <input type="text" id="city-input" placeholder="Москва, СПб, Казань..." />
      <button onclick="searchCity()">Искать</button>
    </div>
  </div>

  <div class="section">
    <div class="section-title">📍 Координаты</div>
    <div class="coords-row">
      <input type="number" id="lat-input" placeholder="Широта" step="0.0001" />
      <span>,</span>
      <input type="number" id="lon-input" placeholder="Долгота" step="0.0001" />
      <input type="number" id="radius-input" value="15" style="width:55px" placeholder="км" />
      <span>км</span>
      <button class="btn" onclick="loadStations()">OK</button>
    </div>
  </div>

  <div class="section">
    <div class="section-title">⛽ Топливо</div>
    <div class="chip-group" id="fuel-chips">
      <div class="chip" data-f="92" onclick="toggleFuel(this)">АИ-92</div>
      <div class="chip" data-f="95" onclick="toggleFuel(this)">АИ-95</div>
      <div class="chip" data-f="98" onclick="toggleFuel(this)">АИ-98</div>
      <div class="chip" data-f="100" onclick="toggleFuel(this)">АИ-100</div>
      <div class="chip" data-f="ДТ" onclick="toggleFuel(this)">ДТ</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">📊 Статус</div>
    <div class="chip-group" id="status-chips">
      <div class="chip status-yes" data-s="yes" onclick="toggleStatus(this)">Есть ✓</div>
      <div class="chip status-queue" data-s="queue" onclick="toggleStatus(this)">Очередь</div>
      <div class="chip status-low" data-s="low" onclick="toggleStatus(this)">Мало</div>
      <div class="chip status-no" data-s="no" onclick="toggleStatus(this)">Нет ✕</div>
    </div>
  </div>

  <div class="section" style="display:flex;gap:8px">
    <button class="btn-outline" onclick="selectAll()">Выбрать все</button>
    <button class="btn-outline" onclick="clearSelection()">Сбросить</button>
  </div>

  <div id="summary"></div>
  <div id="station-list"></div>

  <div id="vote-bar">
    <div class="count">Выбрано: <b id="sel-count">0</b> АЗС</div>
    <div class="vote-btns">
      <button class="vote-btn yes" onclick="bulkVote('yes')">⛽ Есть топливо</button>
      <button class="vote-btn queue" onclick="bulkVote('queue')">🚗 Очередь</button>
      <button class="vote-btn low" onclick="bulkVote('low')">⚠️ Мало</button>
      <button class="vote-btn no" onclick="bulkVote('no')">❌ Нет</button>
    </div>
  </div>
</div>
<div id="toast"></div>

<script>
// ── state ──
let stations=[],selected=new Set(),map,markers={},selectedMarker=null;
const STATUS_LABELS={yes:'Есть',queue:'Очередь',low:'Мало',no:'Нет'};
const STATUS_COLORS = {
  yes:'#22C55E',queue:'#FF7A1A',low:'#FFC400',no:'#FF4D5A',none:'#8A94A6'
};

// ── map init ──
map=L.map('map',{center:[55.75,37.62],zoom:12,zoomControl:true});
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
  attribution:'&copy; <a href="https://openstreetmap.org/copyright">OSM</a>',
  maxZoom:19
}).addTo(map);

map.on('moveend',function(){
  if(!document.getElementById('city-input').value) loadStations();
});

// ── filters ──
function getFilters(){
  let fuel=[],status=[];
  document.querySelectorAll('#fuel-chips .chip.on').forEach(c=>fuel.push(c.dataset.f));
  document.querySelectorAll('#status-chips .chip.status-on').forEach(c=>status.push(c.dataset.s));
  return {fuel,status};
}

function toggleFuel(el){el.classList.toggle('on');applyFilters();}
function toggleStatus(el){el.classList.toggle('status-on');applyFilters();}

function applyFilters(){
  let {fuel,status}=getFilters();
  let filtered=stations;
  if(status.length) filtered=filtered.filter(s=>status.includes(s.status));
  if(fuel.length) filtered=filtered.filter(s=>fuel.some(f=>s.fuel_list.includes(f)));
  renderStationList(filtered);
  updateMarkers(filtered);
}

function selectAll(){
  let {fuel,status}=getFilters();
  let filtered=stations;
  if(status.length) filtered=filtered.filter(s=>status.includes(s.status));
  if(fuel.length) filtered=filtered.filter(s=>fuel.some(f=>s.fuel_list.includes(f)));
  filtered.forEach(s=>selected.add(s.osm_id));
  applyFilters();
}

function clearSelection(){
  selected.clear();
  applyFilters();
}

// ── station list ──
function renderStationList(list){
  let html='',summary='';
  let yes=list.filter(s=>s.status==='yes').length;
  let queue=list.filter(s=>s.status==='queue').length;
  let low=list.filter(s=>s.status==='low').length;
  let no=list.filter(s=>s.status==='no').length;
  summary=`Показано <b>${list.length}</b> из <b>${stations.length}</b> · `+
    `<span style="color:#22C55E">✓${yes}</span> `+
    `<span style="color:#FF7A1A">🚗${queue}</span> `+
    `<span style="color:#FFC400">⚠${low}</span> `+
    `<span style="color:#FF4D5A">✕${no}</span>`;
  document.getElementById('summary').innerHTML=summary;

  list.forEach(s=>{
    let sel=selected.has(s.osm_id)?' selected':'';
    let fuels=s.fuel_list.map(f=>`<span class="fuel-tag">${f}</span>`).join('');
    html+=`<div class="station-card${sel}" onclick="toggleStation('${s.osm_id}',event)" data-id="${s.osm_id}">`+
      `<div class="name"><span class="status-dot" style="background:${s.status_color}"></span> ${s.name}</div>`+
      `<div class="addr">${s.addr||''}</div>`+
      `<div class="meta">${fuels} ${s.distance_km?`· ${s.distance_km.toFixed(1)}км`:''} ${s.confirmations?`· ✓${s.confirmations}`:''} ${s.last_at?`· ${s.last_at.slice(5,16)}`:''}</div>`+
      `</div>`;
  });
  document.getElementById('station-list').innerHTML=html||'<div style="padding:16px;color:#94a3b8">Ничего не найдено</div>';

  document.getElementById('sel-count').textContent=selected.size;
  document.getElementById('vote-bar').classList.toggle('show',selected.size>0);
}

function toggleStation(osm_id,ev){
  if(ev.shiftKey||ev.ctrlKey||ev.metaKey){
    // bulk toggle: select/deselect
    if(selected.has(osm_id)) selected.delete(osm_id);
    else selected.add(osm_id);
  } else {
    // click to fly to marker
    let m=markers[osm_id];
    if(m){
      map.setView(m.getLatLng(),16);
      m.openPopup();
    }
  }
  // if clicked with modifier, update selection display
  if(ev.shiftKey||ev.ctrlKey||ev.metaKey) applyFilters();
}

// ── map markers ──
function stationMarkerHTML(s){
  let c=s.status_color;
  return `<div style="
    width:28px;height:28px;border-radius:50%;background:${c};
    border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.5);
    display:flex;align-items:center;justify-content:center;
    font-size:11px;font-weight:700;color:#000;
  ">${s.fuel_list.length||'?'}</div>`;
}

function updateMarkers(list){
  let shown=new Set(list.map(s=>s.osm_id));
  // remove old
  Object.keys(markers).forEach(id=>{
    if(!shown.has(id)){map.removeLayer(markers[id]);delete markers[id];}
  });
  // add new
  list.forEach(s=>{
    if(!markers[s.osm_id]){
      let icon=L.divIcon({
        html:stationMarkerHTML(s),
        className:'',
        iconSize:[28,28],
        iconAnchor:[14,14]
      });
      let m=L.marker([s.lat,s.lon],{icon}).addTo(map);
      let fuels=s.fuel_list.map(f=>'<span style="display:inline-block;padding:1px 5px;background:#334155;border-radius:3px;margin:1px;font-size:11px">'+f+'</span>').join('');
      let popup=`<div class="popup-name">${s.name}</div>`+
        `<div class="popup-addr">${s.addr||''}</div>`+
        `<div class="popup-meta">${STATUS_LABELS[s.status]||s.status} · ${fuels||'—'}<br>`+
        `✓${s.confirmations} · ${s.last_at? s.last_at.slice(5,16):''}</div>`+
        `<div class="popup-vote">`+
        `<button style="background:#22C55E;color:#000" onclick="quickVote('${s.osm_id}','yes')">⛽ Есть</button>`+
        `<button style="background:#FF7A1A;color:#000" onclick="quickVote('${s.osm_id}','queue')">🚗</button>`+
        `<button style="background:#FFC400;color:#000" onclick="quickVote('${s.osm_id}','low')">⚠</button>`+
        `<button style="background:#FF4D5A;color:#fff" onclick="quickVote('${s.osm_id}','no')">✕ Нет</button>`+
        `</div>`;
      m.bindPopup(popup);
      m.on('click',function(){
        if(selectedMarker){map.removeLayer(selectedMarker);}
        let sel=L.circleMarker([s.lat,s.lon],{radius:18,color:'#3B82F6',weight:3,fillOpacity:0}).addTo(map);
        selectedMarker=sel;
      });
      markers[s.osm_id]=m;
    }
  });
}

// ── API calls ──
async function loadStations(){
  let lat=parseFloat(document.getElementById('lat-input').value)||55.75;
  let lon=parseFloat(document.getElementById('lon-input').value)||37.62;
  let radius=parseInt(document.getElementById('radius-input').value)||15;

  document.getElementById('station-list').innerHTML='<div style="padding:16px;color:#94a3b8">Загрузка...</div>';
  try{
    let resp=await fetch(`/api/stations?lat=${lat}&lon=${lon}&radius=${radius}`);
    let data=await resp.json();
    stations=data.stations||[];
    document.getElementById('lat-input').value=lat.toFixed(4);
    document.getElementById('lon-input').value=lon.toFixed(4);
    selected.clear();
    applyFilters();
    toast(`Загружено ${stations.length} АЗС`,'success');
  }catch(e){
    document.getElementById('station-list').innerHTML='<div style="padding:16px;color:#FF4D5A">Ошибка загрузки: '+e.message+'</div>';
    toast('Ошибка загрузки','error');
  }
}

async function searchCity(){
  let q=document.getElementById('city-input').value.trim();
  if(!q)return;
  try{
    let resp=await fetch('/api/cities?q='+encodeURIComponent(q));
    let data=await resp.json();
    if(data.results&&data.results.length){
      let c=data.results[0];
      document.getElementById('lat-input').value=c.lat.toFixed(4);
      document.getElementById('lon-input').value=c.lon.toFixed(4);
      map.setView([c.lat,c.lon],12);
      loadStations();
      toast('Город: '+c.name,'success');
    }else{
      toast('Город не найден','error');
    }
  }catch(e){
    toast('Ошибка поиска','error');
  }
}

async function quickVote(osm_id,status){
  try{
    let s=stations.find(s=>s.osm_id===osm_id);
    let resp=await fetch('/api/vote',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        osm_id:osm_id,
        status:status,
        name:s?s.name:'',
        lat:s?s.lat:0,
        lon:s?s.lon:0
      })
    });
    let r=await resp.json();
    if(r.success){
      toast('✅ Проголосовано: '+STATUS_LABELS[status],'success');
      // refresh markers after a moment
      setTimeout(loadStations,800);
    }else{
      toast('⚠ '+ (r.reason||'Ошибка'),'error');
    }
  }catch(e){
    toast('Ошибка: '+e.message,'error');
  }
}

async function bulkVote(status){
  if(selected.size===0) return;
  let ids=Array.from(selected);
  let text=prompt('Комментарий (необязательно):','');
  if(text===null) return; // cancelled

  toast(`Голосование ${ids.length} АЗС...`);

  let ok=0,fail=0;
  for(let i=0;i<ids.length;i++){
    let osm_id=ids[i];
    let s=stations.find(s=>s.osm_id===osm_id);
    try{
      let resp=await fetch('/api/vote',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          osm_id:osm_id,
          status:status,
          name:s?s.name:'',
          lat:s?s.lat:0,
          lon:s?s.lon:0,
          text:text||''
        })
      });
      let r=await resp.json();
      if(r.success) ok++;
      else fail++;
    }catch(e){fail++;}
    // small delay
    if(i<ids.length-1) await new Promise(r=>setTimeout(r,400+Math.random()*300));
  }
  toast(`Готово: ${ok} успешно, ${fail} ошибок`, ok>0?'success':'error');
  selected.clear();
  loadStations();
}

// ── toast ──
let toastTimer;
function toast(msg,type){
  let el=document.getElementById('toast');
  el.textContent=msg;
  el.className=type||'';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.classList.remove('show'),2500);
}

// ── keyboard: ctrl+a = select all filtered ──
document.addEventListener('keydown',function(e){
  if((e.ctrlKey||e.metaKey)&&e.key==='a'){
    e.preventDefault();
    selectAll();
  }
});

// ── init ──
loadStations();
</script>
</body>
</html>"""


class APIHandler(BaseHTTPRequestHandler):
    """HTTP handler serving the map UI and JSON API endpoints."""

    _api: Optional[GdebenzAPI] = None

    @property
    def api(self) -> GdebenzAPI:
        assert self._api is not None, "API not initialized"
        return self._api

    @classmethod
    def set_api(cls, api: GdebenzAPI):
        cls._api = api

    def log_message(self, format, *args):
        """Suppress default logging to stderr."""
        pass

    def _send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, html, status=200):
        body = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers", "Content-Type"
        )
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/" or path == "/index.html":
            self._send_html(HTML_TEMPLATE)

        elif path == "/api/stations":
            try:
                lat = float(qs.get("lat", [55.75])[0])
                lon = float(qs.get("lon", [37.62])[0])
                radius = float(qs.get("radius", [15])[0])
            except (ValueError, IndexError):
                self._send_json({"error": "invalid params"}, 400)
                return

            try:
                stations, summary = self.api.get_nearby(lat, lon, radius)
                self._send_json({
                    "stations": [s.to_dict() for s in stations],
                    "summary": summary,
                    "center": {"lat": lat, "lon": lon},
                })
            except Exception as e:
                self._send_json({"error": str(e)}, 500)

        elif path == "/api/cities":
            q = qs.get("q", [""])[0]
            if not q:
                self._send_json({"results": []})
                return
            try:
                results = self.api.search_city(q)
                self._send_json({"results": results})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)

        elif path == "/api/geoip":
            try:
                data = self.api.geoip()
                self._send_json(data)
            except Exception as e:
                self._send_json({"error": str(e)}, 500)

        else:
            self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # Read body
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""
        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self._send_json({"error": "invalid json"}, 400)
            return

        if path == "/api/vote":
            osm_id = data.get("osm_id", "")
            status = data.get("status", "")
            name = data.get("name", "")
            lat = float(data.get("lat", 0))
            lon = float(data.get("lon", 0))
            text = data.get("text", "")

            if not osm_id or status not in STATUSES:
                self._send_json(
                    {"success": False, "reason": "invalid params"}, 400
                )
                return

            try:
                result = self.api.vote(
                    osm_id=osm_id,
                    status=status,
                    name=name,
                    lat=lat,
                    lon=lon,
                    text=text,
                )
                self._send_json(result)
            except Exception as e:
                self._send_json(
                    {"success": False, "reason": str(e)}, 500
                )

        else:
            self._send_json({"error": "not found"}, 404)


def cmd_serve(args, api: GdebenzAPI):
    """Start the web server with map UI."""
    port = args.port or 8080
    host = args.host or "0.0.0.0"

    # Resolve initial coordinates
    try:
        lat, lon = resolve_coords(
            api, city=args.city, lat=args.lat, lon=args.lon
        )
    except Exception:
        lat, lon = 55.75, 37.62

    # Attach API instance to handler class
    APIHandler.set_api(api)

    server = HTTPServer((host, port), APIHandler)

    # Determine local IP
    import socket
    local_ip = "127.0.0.1"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        pass

    print(f"""
╔═══════════════════════════════════════════════════════════╗
║                   ⛽ ГдеБЕНЗ Web UI                       ║
╠═══════════════════════════════════════════════════════════╣
║  Локально:   http://127.0.0.1:{port:<5}                      ║
║  Локальная   http://{local_ip}:{port:<5}                      ║
║    сеть:                                                 ║
╠═══════════════════════════════════════════════════════════╣
║  Центр карты: {lat:.4f}, {lon:.4f}                         ║
║  Нажмите Ctrl+C для остановки                            ║
╚═══════════════════════════════════════════════════════════╝
""")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 Сервер остановлен.")
        server.shutdown()


# ─────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="GdeBenz.ru — bulk vote on gas stations with fuel filtering",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"""
Примеры:
  %(prog)s list --city Москва --fuel 95,ДТ --status yes
  %(prog)s list --lat 55.75 --lon 37.62 --radius 10
  %(prog)s vote --city Москва --status no --vote-status yes --text "появился бензин"
  %(prog)s vote --city Москва --status no --vote-status yes --dry-run
  %(prog)s serve --port 8080                 # web UI на локальной сети
  %(prog)s serve --city Москва --port 8080   # с указанием города

Статусы: yes (есть), queue (очередь), low (мало), no (нет)
Топливо: {', '.join(FUEL_GRADES)}
        """,
    )
    parser.add_argument(
        "--fingerprint",
        help="Fingerprint ID (UUID hex). Генерируется автоматически и сохраняется.",
    )
    parser.add_argument(
        "--fp-file",
        default=os.path.expanduser("~/.gdebenz_fp"),
        help="Файл для хранения fingerprint (по умолчанию ~/.gdebenz_fp)",
    )

    sub = parser.add_subparsers(dest="command")

    # -- list --
    p_list = sub.add_parser("list", help="Показать АЗС с фильтрацией")
    p_list.add_argument("--city", help="Город")
    p_list.add_argument("--lat", type=float, help="Широта")
    p_list.add_argument("--lon", type=float, help="Долгота")
    p_list.add_argument("--radius", type=float, default=20, help="Радиус в км (по умолчанию 20)")
    p_list.add_argument("--bounding-box", help="Bounding box: lat1,lon1,lat2,lon2")
    p_list.add_argument("--fuel", help="Фильтр топлива через запятую: 92,95,98,100,ДТ")
    p_list.add_argument("--status", help="Фильтр статуса через запятую: yes,queue,low,no")
    p_list.add_argument("--brand", help="Фильтр бренда (частичное совпадение)")
    p_list.add_argument("--min-confirmations", type=int, help="Минимум подтверждений")
    p_list.add_argument("--limit", type=int, help="Ограничить количество")
    p_list.set_defaults(func=cmd_list)

    # -- vote --
    p_vote = sub.add_parser("vote", help="Массовое голосование")
    p_vote.add_argument("--city", help="Город")
    p_vote.add_argument("--lat", type=float, help="Широта")
    p_vote.add_argument("--lon", type=float, help="Долгота")
    p_vote.add_argument("--radius", type=float, default=20, help="Радиус в км (по умолчанию 20)")
    p_vote.add_argument("--bounding-box", help="Bounding box: lat1,lon1,lat2,lon2")
    p_vote.add_argument("--fuel", help="Фильтр топлива: только АЗС с указанными видами топлива")
    p_vote.add_argument("--status", help="Фильтр текущего статуса: только АЗС с этим статусом")
    p_vote.add_argument("--brand", help="Фильтр бренда")
    p_vote.add_argument("--min-confirmations", type=int, help="Минимум подтверждений")
    p_vote.add_argument("--limit", type=int, help="Максимум АЗС для голосования")
    p_vote.add_argument("--vote-status", dest="vote_status", help="Статус для голосования: yes, queue, low, no")
    p_vote.add_argument("--text", help="Текст комментария")
    p_vote.add_argument("--on-site", action="store_true", help="Отметка 'на месте' (vlat/vlon = координаты АЗС)")
    p_vote.add_argument("--dry-run", action="store_true", help="Предпросмотр без отправки голосов")
    p_vote.add_argument("--yes", "-y", action="store_true", help="Пропустить подтверждение")
    p_vote.set_defaults(func=cmd_vote)

    # -- serve --
    p_serve = sub.add_parser("serve", help="Запустить Web UI с картой OpenStreetMap")
    p_serve.add_argument("--port", type=int, default=8080, help="Порт (по умолчанию 8080)")
    p_serve.add_argument("--host", default="0.0.0.0", help="Хост (по умолчанию 0.0.0.0 — вся сеть)")
    p_serve.add_argument("--city", help="Город по умолчанию")
    p_serve.add_argument("--lat", type=float, help="Широта по умолчанию")
    p_serve.add_argument("--lon", type=float, help="Долгота по умолчанию")
    p_serve.set_defaults(func=cmd_serve)

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    # Load or generate fingerprint
    fp_file = args.fp_file
    fingerprint = args.fingerprint
    if not fingerprint and os.path.exists(fp_file):
        fingerprint = open(fp_file).read().strip()
    if not fingerprint:
        fingerprint = uuid.uuid4().hex
        os.makedirs(os.path.dirname(fp_file), exist_ok=True)
        with open(fp_file, "w") as f:
            f.write(fingerprint)
        print(f"🔑 Новый fingerprint сохранён в {fp_file}")

    api = GdebenzAPI(fingerprint=fingerprint)
    args.func(args, api)


if __name__ == "__main__":
    main()
