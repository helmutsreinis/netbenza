#!/usr/bin/env python3
"""
Benzin-Status.tech API wrapper — second gas station map service.

Discovered APIs:
  GET  /api/stations?bbox=lat1,lng1,lat2,lng2&limit=&fuel=&agg=
  GET  /api/stations/{id}
  POST /api/reports  {station_id, status, fuel_types, prices}
  POST /api/prices/vote  {station_id, fuel, value}
  POST /api/deliveries/{id}/vote  {value, kind}
  POST /api/queue  {station_id, cars}
  GET  /api/search?q=
  GET  /api/cheapest?lat=&lng=&fuel=&radius=
  GET  /api/device/preferences
  POST /api/gps/ping, /api/gps/start, /api/gps/stop

Station fields:
  id, name, brand, lat, lng, address, source, status,
  lastReportAt, limitLiters, fuelTypes, canister,
  price, priceAt, priceSource, delivery

Statuses: none, available, limited, unavailable, queue
Fuel types: ai92, ai95, ai98, ai100, dt, gas
"""

import math
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

import requests

BASE_URL = "https://map.benzin-status.tech"
DEVICE_ID_FILE = os.path.expanduser("~/.benzin_device_id")


def _get_device_id() -> str:
    """Generate/load persistent X-Device-Id matching the site's cn() function."""
    try:
        if os.path.exists(DEVICE_ID_FILE):
            did = open(DEVICE_ID_FILE).read().strip()
            if re.match(r'^[A-Za-z0-9_-]{8,64}$', did):
                return did
    except Exception:
        pass
    did = str(uuid.uuid4()).replace("-", "")[:36]
    try:
        with open(DEVICE_ID_FILE, "w") as f:
            f.write(did)
    except Exception:
        pass
    return did


DEFAULT_HEADERS = {
    "Referer": "https://map.benzin-status.tech/",
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    "X-Device-Id": _get_device_id(),
}

# Map benzin-status fuel types → gdebenz-style codes
FUEL_MAP = {
    "ai92": "92",
    "ai95": "95",
    "ai98": "98",
    "ai100": "100",
    "dt": "ДТ",
    "gas": "ГАЗ",
}
FUEL_MAP_REVERSE = {v: k for k, v in FUEL_MAP.items()}

# Fuel grades in gdebenz-compatible format
BENZIN_FUEL_GRADES = ["92", "95", "98", "100", "ДТ", "ГАЗ"]

# Statuses — DISPLAY values (what the API returns in station data)
BENZIN_DISPLAY_STATUSES = ["available", "limited", "unavailable", "queue", "none"]
BENZIN_DISPLAY_LABELS_EN = {
    "available": "Fuel Available",
    "limited": "Limited",
    "unavailable": "No Fuel",
    "queue": "Queue",
    "none": "No Reports",
}

# Statuses — REPORT values (what the /api/reports POST endpoint actually accepts)
# Tested: available✓, limited✓ (when not rate-limited), none✓, unavailable✗, queue✗
BENZIN_STATUSES = ["available", "limited", "none"]
BENZIN_STATUS_LABELS_EN = {
    "available": "Fuel Available",
    "limited": "Limited",
    "none": "No Fuel",       # reporting "none" effectively marks station as unavailable
}

# Map display status → report status
DISPLAY_TO_REPORT_STATUS = {
    "available": "available",
    "limited": "limited",
    "unavailable": "none",   # "No Fuel" → report as "none"
    "queue": "available",     # "Queue" → map to "available" (queue not reportable)
    "none": None,             # can't report "none" when it's already "none"
}


@dataclass
class BenzinStation:
    id: int                    # numeric station ID
    name: str
    brand: str
    lat: float
    lng: float
    address: str
    source: str
    status: str
    last_report_at: int = 0    # timestamp ms
    limit_liters: Optional[int] = None
    fuel_types: list[str] = field(default_factory=list)  # e.g. ["ai92", "ai95"]
    canister: Optional[bool] = None
    price: Optional[float] = None
    price_at: Optional[int] = None
    price_source: Optional[str] = None
    delivery: Optional[int] = None
    distance_km: float = 0.0

    @property
    def station_id(self) -> str:
        """String ID for compatibility with gdebenz data model."""
        return str(self.id)

    @property
    def fuel_list(self) -> list[str]:
        """Gdebenz-compatible fuel list."""
        return [FUEL_MAP.get(f, f) for f in self.fuel_types]

    @property
    def status_label(self) -> str:
        return BENZIN_DISPLAY_LABELS_EN.get(self.status, self.status)


class BenzinStatusAPI:
    """API client for map.benzin-status.tech."""

    def __init__(self, session: Optional[requests.Session] = None):
        self._session = session or requests.Session()
        self._session.headers.update(DEFAULT_HEADERS)

    def get_stations(self, lat: float, lng: float, radius_km: float = 20, max_pages: int = 2) -> list[BenzinStation]:
        """
        Fetch stations around a point using a bounding box derived from radius.
        max_pages: maximum number of API pages to fetch (200 stations per page).
        Set to 1 for fast responses, higher for completeness.
        """
        dlat = radius_km / 111.0
        dlng = radius_km / (111.0 * math.cos(math.radians(lat)))
        lat1, lat2 = lat - dlat, lat + dlat
        lng1, lng2 = lng - dlng, lng + dlng

        all_stations = []
        limit = 200
        offset = 0
        pages_fetched = 0

        while pages_fetched < max_pages:
            try:
                resp = self._session.get(
                    f"{BASE_URL}/api/stations",
                    params={
                        "bbox": f"{lat1:.6f},{lng1:.6f},{lat2:.6f},{lng2:.6f}",
                        "limit": limit,
                        "offset": offset,
                    },
                    timeout=15,
                )
                if resp.status_code == 429:
                    break
                resp.raise_for_status()
                data = resp.json()

                if "error" in data:
                    break

                stations = data.get("stations", [])
                if not stations:
                    break

                for raw in stations:
                    s = _parse_benzin_station(raw)
                    s.distance_km = _haversine(lat, lng, s.lat, s.lng)
                    all_stations.append(s)

                if len(stations) < limit:
                    break
                offset += limit
                pages_fetched += 1
                time.sleep(0.2)
            except requests.exceptions.HTTPError:
                break

        return all_stations

    def get_station(self, station_id: int) -> Optional[dict]:
        """Get single station detail."""
        try:
            resp = self._session.get(
                f"{BASE_URL}/api/stations/{station_id}",
                timeout=10,
            )
            if resp.status_code == 200:
                return resp.json()
        except Exception:
            pass
        return None

    def report(
        self,
        station_id: int,
        status: str,
        fuel_types: list[str] = None,
        price: Optional[float] = None,
    ) -> dict:
        """
        Submit a status report for a station.

        Args:
            station_id: Station numeric ID
            status: "available", "limited", "unavailable", "queue"
            fuel_types: list of benzin fuel codes like ["ai92", "ai95"]
            price: optional price for the first fuel type
        """
        if status not in BENZIN_STATUSES:
            raise ValueError(f"Invalid status '{status}'. Must be one of {BENZIN_STATUSES}")

        fuel_types = fuel_types or []
        # Convert gdebenz-style fuel codes to benzin-style
        benzin_fuels = [FUEL_MAP_REVERSE.get(f, f) for f in fuel_types]

        body = {
            "station_id": station_id,
            "status": status,
            "fuel_types": benzin_fuels,
            "prices": {},
        }

        # If price given, set for first fuel type
        if price is not None and benzin_fuels:
            body["prices"] = {benzin_fuels[0]: price}

        try:
            resp = self._session.post(
                f"{BASE_URL}/api/reports",
                json=body,
                timeout=15,
            )
            if resp.status_code == 200:
                return {"success": True, "data": resp.json()}
            elif resp.status_code == 409:
                return {"success": False, "reason": "already reported"}
            elif resp.status_code == 429:
                return {"success": False, "reason": "rate limited"}
            else:
                detail = ""
                try:
                    detail = resp.json().get("error", "")
                except Exception:
                    pass
                return {"success": False, "reason": detail or f"HTTP {resp.status_code}"}
        except Exception as e:
            return {"success": False, "reason": str(e)}


def _parse_benzin_station(raw: dict) -> BenzinStation:
    def _int(v, default=0):
        return int(v) if v is not None else default

    def _float(v, default=0.0):
        return float(v) if v is not None else default

    return BenzinStation(
        id=_int(raw.get("id"), 0),
        name=raw.get("name", "") or "Gas Station",
        brand=raw.get("brand", "") or "",
        lat=_float(raw.get("lat"), 0),
        lng=_float(raw.get("lng"), 0),
        address=raw.get("address", "") or "",
        source=raw.get("source", ""),
        status=raw.get("status", "none"),
        last_report_at=_int(raw.get("lastReportAt"), 0),
        limit_liters=_int(raw.get("limitLiters")) if raw.get("limitLiters") is not None else None,
        fuel_types=raw.get("fuelTypes", []) or [],
        canister=raw.get("canister"),
        price=_float(raw.get("price")) if raw.get("price") is not None else None,
        price_at=_int(raw.get("priceAt")) if raw.get("priceAt") is not None else None,
        price_source=raw.get("priceSource"),
        delivery=_int(raw.get("delivery")) if raw.get("delivery") is not None else None,
    )


def _haversine(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Distance in km between two points."""
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlng / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
