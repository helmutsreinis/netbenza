#!/usr/bin/env python3
"""
FastAPI server for GdeBenz.ru bulk voting UI.
Run: python3 server.py  →  http://localhost:8585
"""

import sys
import os
import random
import time
from pathlib import Path
from urllib.parse import quote

# Add parent to path so we can import the wrapper
sys.path.insert(0, str(Path(__file__).parent.parent))

from gdebenz_wrapper import (
    GdebenzAPI,
    Station,
    filter_stations,
    resolve_coords,
    FUEL_GRADES,
    STATUSES,
)
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional
import uvicorn

app = FastAPI(title="GdeBenz Bulk Voter", version="1.0")

# Global API client — fingerprint loaded from file
FP_FILE = os.path.expanduser("~/.gdebenz_fp")
_fp = None
if os.path.exists(FP_FILE):
    _fp = open(FP_FILE).read().strip()
api = GdebenzAPI(fingerprint=_fp)


# ── Hardcoded Data ────────────────────────────────────────────

TOP_CITIES = [
    {"name": "Moscow", "name_ru": "Москва", "lat": 55.7520, "lon": 37.6178},
    {"name": "Saint Petersburg", "name_ru": "Санкт-Петербург", "lat": 59.9386, "lon": 30.3141},
    {"name": "Novosibirsk", "name_ru": "Новосибирск", "lat": 55.0302, "lon": 82.9204},
    {"name": "Yekaterinburg", "name_ru": "Екатеринбург", "lat": 56.8389, "lon": 60.6057},
    {"name": "Kazan", "name_ru": "Казань", "lat": 55.7961, "lon": 49.1064},
    {"name": "Nizhny Novgorod", "name_ru": "Нижний Новгород", "lat": 56.3287, "lon": 44.0020},
    {"name": "Chelyabinsk", "name_ru": "Челябинск", "lat": 55.1644, "lon": 61.4368},
    {"name": "Samara", "name_ru": "Самара", "lat": 53.1959, "lon": 50.1002},
    {"name": "Omsk", "name_ru": "Омск", "lat": 54.9893, "lon": 73.3682},
    {"name": "Rostov-on-Don", "name_ru": "Ростов-на-Дону", "lat": 47.2357, "lon": 39.7015},
    {"name": "Ufa", "name_ru": "Уфа", "lat": 54.7388, "lon": 55.9721},
    {"name": "Krasnoyarsk", "name_ru": "Красноярск", "lat": 56.0106, "lon": 92.8526},
    {"name": "Perm", "name_ru": "Пермь", "lat": 58.0105, "lon": 56.2294},
    {"name": "Voronezh", "name_ru": "Воронеж", "lat": 51.6606, "lon": 39.2003},
    {"name": "Volgograd", "name_ru": "Волгоград", "lat": 48.7080, "lon": 44.5133},
    {"name": "Krasnodar", "name_ru": "Краснодар", "lat": 45.0355, "lon": 38.9753},
    {"name": "Saratov", "name_ru": "Саратов", "lat": 51.5336, "lon": 46.0343},
    {"name": "Tyumen", "name_ru": "Тюмень", "lat": 57.1522, "lon": 65.5272},
    {"name": "Tolyatti", "name_ru": "Тольятти", "lat": 53.5078, "lon": 49.4204},
    {"name": "Izhevsk", "name_ru": "Ижевск", "lat": 56.8498, "lon": 53.2045},
    {"name": "Barnaul", "name_ru": "Барнаул", "lat": 53.3548, "lon": 83.7698},
    {"name": "Ulyanovsk", "name_ru": "Ульяновск", "lat": 54.3142, "lon": 48.4031},
    {"name": "Irkutsk", "name_ru": "Иркутск", "lat": 52.2864, "lon": 104.2807},
    {"name": "Khabarovsk", "name_ru": "Хабаровск", "lat": 48.4802, "lon": 135.0719},
    {"name": "Yaroslavl", "name_ru": "Ярославль", "lat": 57.6261, "lon": 39.8845},
    {"name": "Vladivostok", "name_ru": "Владивосток", "lat": 43.1155, "lon": 131.8855},
    {"name": "Makhachkala", "name_ru": "Махачкала", "lat": 42.9849, "lon": 47.5047},
    {"name": "Tomsk", "name_ru": "Томск", "lat": 56.4846, "lon": 84.9486},
    {"name": "Orenburg", "name_ru": "Оренбург", "lat": 51.7682, "lon": 55.0970},
    {"name": "Kemerovo", "name_ru": "Кемерово", "lat": 55.3550, "lon": 86.0869},
    {"name": "Novokuznetsk", "name_ru": "Новокузнецк", "lat": 53.7558, "lon": 87.1099},
    {"name": "Ryazan", "name_ru": "Рязань", "lat": 54.6269, "lon": 39.6916},
    {"name": "Astrakhan", "name_ru": "Астрахань", "lat": 46.3476, "lon": 48.0303},
    {"name": "Naberezhnye Chelny", "name_ru": "Набережные Челны", "lat": 55.7256, "lon": 52.4153},
    {"name": "Penza", "name_ru": "Пенза", "lat": 53.1954, "lon": 45.0181},
    {"name": "Lipetsk", "name_ru": "Липецк", "lat": 52.6032, "lon": 39.5999},
    {"name": "Kirov", "name_ru": "Киров", "lat": 58.5966, "lon": 49.6601},
    {"name": "Cheboksary", "name_ru": "Чебоксары", "lat": 56.1322, "lon": 47.2519},
    {"name": "Tula", "name_ru": "Тула", "lat": 54.1931, "lon": 37.6175},
    {"name": "Kaliningrad", "name_ru": "Калининград", "lat": 54.7104, "lon": 20.4522},
    {"name": "Balashikha", "name_ru": "Балашиха", "lat": 55.7963, "lon": 37.9382},
    {"name": "Kursk", "name_ru": "Курск", "lat": 51.7373, "lon": 36.1874},
    {"name": "Stavropol", "name_ru": "Ставрополь", "lat": 45.0448, "lon": 41.9692},
    {"name": "Sevastopol", "name_ru": "Севастополь", "lat": 44.6166, "lon": 33.5254},
    {"name": "Sochi", "name_ru": "Сочи", "lat": 43.5855, "lon": 39.7231},
    {"name": "Tver", "name_ru": "Тверь", "lat": 56.8587, "lon": 35.9176},
    {"name": "Bryansk", "name_ru": "Брянск", "lat": 53.2434, "lon": 34.3637},
    {"name": "Belgorod", "name_ru": "Белгород", "lat": 50.5977, "lon": 36.5858},
    {"name": "Surgut", "name_ru": "Сургут", "lat": 61.2540, "lon": 73.3962},
    {"name": "Nizhny Tagil", "name_ru": "Нижний Тагил", "lat": 57.9105, "lon": 59.9816},
]

TOP_BRANDS = [
    "Лукойл", "Газпромнефть", "Роснефть", "Татнефть", "Башнефть",
    "Shell", "ТНК", "Трасса", "Топаз", "ННК", "Flash", "Fueller",
    "Газпром", "Asco", "Ирбис", "Нефтьмагистраль", "Калининграднефтепродукт",
    "Сургутнефтегаз", "ТАИФ-НК", "А+", "Энергия", "GP", "G7",
    "Formula", "Роса", "Нефтемаркет", "ОПТИ", "Прайм", "Varta",
    "Gulf", "Петрол", "Октан", "Сибнефть", "Эталон", "ОЛВИ",
    "Трансбункер", "Радуга", "Альянс", "Солид", "Омни",
]

STATUS_LABELS_EN = {
    "yes": "Fuel Available",
    "queue": "Queue",
    "low": "Low Fuel",
    "no": "No Fuel",
}

# Russian comment templates for random selection
COMMENT_TEMPLATES = {
    "positive": [
        "Есть топливо, все колонки работают",
        "Заправился без проблем, всё есть",
        "Бензин есть, очереди нет",
        "Все марки топлива в наличии",
        "Работает, заправился быстро",
        "Есть и 92 и 95 и дизель",
        "Полные баки, приезжайте",
        "Без перебоев, топливо есть",
        "Заправка работает штатно",
        "Всё OK, топливо на всех колонках",
        "Дизель и бензин есть",
        "Свободно, топливо в наличии",
        "Работает круглосуточно, топливо есть",
        "Заехал — заправился сразу",
        "Всё работает, персонал приветливый",
        "Только что заправился, 95 и 92 есть",
        "Очереди нет, подъехал и заправился",
        "Качество топлива отличное",
        "Заправляюсь здесь постоянно, проблем нет",
        "Ночью тоже работает, заправился без проблем",
        "Оплата картой работает, всё чётко",
        "Есть и газ и бензин, всё в наличии",
        "Новая партия топлива, все колонки работают",
        "Заправил полный бак, всё отлично",
        "Работают все ТРК, топливо есть",
        "Приехал — заправился, без задержек",
        "Топливо свежее, расход нормальный",
        "Машин мало, заправка свободна",
        "92, 95, 98 — всё есть",
        "ДТ зимнее есть, залил полный бак",
    ],
    "negative": [
        "Топлива нет, не тратьте время",
        "Бензина нет уже несколько часов",
        "Только дизель, бензина нет",
        "Закрыто, не работает",
        "Очередь на час, топлива мало",
        "92 нет, только 95 остался",
        "Колонки не работают",
        "Топливо закончилось",
        "Привоз обещали но пока нет",
        "Не заправиться, сухо",
        "Только газ, бензина нет",
        "Перебои с поставками",
        "Работает одна колонка из четырёх",
        "Огромная очередь, проезжайте мимо",
        "Налива нет",
        "Закончился 95, ждите подвоза",
        "Не работает терминал оплаты",
        "Топливо есть только по топливным картам",
        "Качество топлива ужасное, не советую",
        "Вода в бензине, после заправки машина троит",
        "Недолив, проверяйте чеки",
        "Колонка глючит, заправиться невозможно",
        "Смена пересменка, не работают 30 минут",
        "Только наличные, терминал не работает",
        "Дизель закончился, бензин пока есть",
        "АЗС на реконструкции, закрыто",
        "Нет электричества, колонки не работают",
        "Топливо старое, расход вырос в два раза",
        "Обещают подвоз через 2 часа, пока сухо",
        "Только АИ-100 остался, всё остальное кончилось",
    ],
}


# ── API Models ──────────────────────────────────────────────

class StationOut(BaseModel):
    osm_id: str
    name: str
    brand: str
    addr: str
    lat: float
    lon: float
    status: str
    status_label: str
    fuels_now: str
    fuel_list: list[str]
    confirmations: int
    distance_km: float
    last_at: str

    @classmethod
    def from_station(cls, s: Station) -> "StationOut":
        return cls(
            osm_id=s.osm_id,
            name=s.name,
            brand=s.brand,
            addr=s.addr,
            lat=s.lat,
            lon=s.lon,
            status=s.status,
            status_label=STATUS_LABELS_EN.get(s.status, s.status),
            fuels_now=s.fuels_now,
            fuel_list=s.fuel_list,
            confirmations=s.confirmations,
            distance_km=s.distance_km,
            last_at=s.last_at,
        )


class VoteRequest(BaseModel):
    osm_ids: list[str]
    vote_status: str  # yes, queue, low, no
    text: str = ""
    on_site: bool = False
    city: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None


class VoteResult(BaseModel):
    osm_id: str
    name: str
    success: bool
    reason: str = ""


class ListResponse(BaseModel):
    center: dict
    summary: dict
    total: int          # total unfiltered stations
    filtered_total: int  # total filtered (before slicing)
    page: int
    pages: int
    stations: list[StationOut]


class ConfigOut(BaseModel):
    fuel_grades: list[str]
    statuses: list[dict]
    cities: list[dict]
    brands: list[str]
    comment_templates: dict  # {positive: [...], negative: [...]}


class PresenceRequest(BaseModel):
    clientId: str
    handle: str = "Anonymous"
    avatar: str = ""
    activity: str = "online"
    detail: str = ""


PRESENCE_ACTIVE_MS = 25_000
PRESENCE_ACTIVITIES = {"online", "searching", "filtering", "selecting", "voting", "done", "idle"}
presence_users: dict[str, dict] = {}


def _presence_client_id(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in value.strip())[:80].strip("-")
    if not cleaned:
        raise ValueError("clientId is required")
    return cleaned


def _presence_snapshot() -> dict:
    now = int(time.time() * 1000)
    expired = [
        client_id for client_id, user in presence_users.items()
        if now - int(user.get("lastSeen", 0)) > PRESENCE_ACTIVE_MS
    ]
    for client_id in expired:
        presence_users.pop(client_id, None)

    users = sorted(
        presence_users.values(),
        key=lambda user: (user.get("handle", ""), user.get("clientId", "")),
    )
    return {"users": users, "activeWindowMs": PRESENCE_ACTIVE_MS, "serverTime": now}


# ── API Routes ───────────────────────────────────────────────

@app.get("/api/config", response_model=ConfigOut)
def get_config():
    return ConfigOut(
        fuel_grades=FUEL_GRADES,
        statuses=[
            {"value": s, "label": l, "color": _status_color(s)}
            for s, l in STATUS_LABELS_EN.items()
        ],
        cities=TOP_CITIES,
        brands=TOP_BRANDS,
        comment_templates=COMMENT_TEMPLATES,
    )


@app.get("/api/stations", response_model=ListResponse)
def list_stations(
    city: str = Query(None),
    lat: float = Query(None),
    lon: float = Query(None),
    radius: float = Query(20),
    fuel: str = Query(None),
    status: str = Query(None),
    brand: str = Query(None),
    offset: int = Query(0),
    limit: int = Query(20),
):
    """List stations with filters and pagination."""
    try:
        clat, clon = resolve_coords(api, city=city, lat=lat, lon=lon)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    stations, summary = api.get_nearby(clat, clon, radius)

    fuel_types = [f.strip() for f in fuel.split(",")] if fuel else None
    statuses = [s.strip() for s in status.split(",")] if status else None

    filtered = filter_stations(stations, fuel_types=fuel_types, statuses=statuses, brand=brand)
    filtered_total = len(filtered)
    pages = max(1, (filtered_total + limit - 1) // limit) if filtered_total > 0 else 1
    page = offset // limit + 1 if limit > 0 else 1

    # Slice for the current page
    page_stations = filtered[offset:offset + limit] if limit > 0 else filtered

    return ListResponse(
        center={"lat": clat, "lon": clon, "radius": radius},
        summary=summary,
        total=len(stations),
        filtered_total=filtered_total,
        page=page,
        pages=pages,
        stations=[StationOut.from_station(s) for s in page_stations],
    )


@app.get("/api/stations/ids")
def list_station_ids(
    city: str = Query(None),
    lat: float = Query(None),
    lon: float = Query(None),
    radius: float = Query(20),
    fuel: str = Query(None),
    status: str = Query(None),
    brand: str = Query(None),
):
    """Return just osm_ids for ALL filtered stations (no pagination). Used for bulk voting."""
    try:
        clat, clon = resolve_coords(api, city=city, lat=lat, lon=lon)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    stations, _ = api.get_nearby(clat, clon, radius)

    fuel_types = [f.strip() for f in fuel.split(",")] if fuel else None
    statuses = [s.strip() for s in status.split(",")] if status else None

    filtered = filter_stations(stations, fuel_types=fuel_types, statuses=statuses, brand=brand)
    return {"ids": [s.osm_id for s in filtered], "total": len(filtered)}


@app.post("/api/vote/preview", response_model=list[StationOut])
def vote_preview(
    city: str = Query(None),
    lat: float = Query(None),
    lon: float = Query(None),
    radius: float = Query(20),
    fuel: str = Query(None),
    status: str = Query(None),
    brand: str = Query(None),
    limit: int = Query(200),
):
    """Preview which stations would be voted on."""
    try:
        clat, clon = resolve_coords(api, city=city, lat=lat, lon=lon)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    stations, _ = api.get_nearby(clat, clon, radius)

    fuel_types = [f.strip() for f in fuel.split(",")] if fuel else None
    statuses = [s.strip() for s in status.split(",")] if status else None

    filtered = filter_stations(stations, fuel_types=fuel_types, statuses=statuses, brand=brand)
    if limit and limit < len(filtered):
        filtered = filtered[:limit]

    return [StationOut.from_station(s) for s in filtered]


@app.post("/api/vote", response_model=list[VoteResult])
def vote_bulk(req: VoteRequest):
    """Execute bulk vote."""
    if req.vote_status not in STATUSES:
        raise HTTPException(status_code=400, detail=f"Invalid status: {req.vote_status}")

    # Resolve voter coordinates
    vlat, vlon = 0.0, 0.0
    if req.city:
        try:
            vlat, vlon = resolve_coords(api, city=req.city)
        except ValueError:
            pass
    if req.lat and req.lon:
        vlat, vlon = req.lat, req.lon

    # Resolve comment text: pick random from template if requested
    text = req.text
    if text in ("__random_positive__", "__random_negative__"):
        category = "positive" if text == "__random_positive__" else "negative"
        templates = COMMENT_TEMPLATES.get(category, [])
        text = random.choice(templates) if templates else ""

    results = []
    for osm_id in req.osm_ids:
        try:
            info = api.get_station_comments(osm_id)
            name = info.get("addr", "") or osm_id

            result = api.vote(
                osm_id=osm_id,
                status=req.vote_status,
                name=name,
                lat=0,
                lon=0,
                text=text,
                vlat=vlat,
                vlon=vlon,
                on_site=req.on_site,
            )
            results.append(VoteResult(
                osm_id=osm_id,
                name=name,
                success=result.get("success", False),
                reason=result.get("reason", ""),
            ))
        except Exception as e:
            results.append(VoteResult(
                osm_id=osm_id,
                name="",
                success=False,
                reason=str(e),
            ))

    return results


@app.get("/api/city/search")
def search_city(q: str = Query(...)):
    """Search for a city."""
    try:
        cities = api.search_city(q)
        return {"results": cities}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/presence")
def get_presence():
    return _presence_snapshot()


@app.post("/api/presence")
def post_presence(req: PresenceRequest):
    try:
        client_id = _presence_client_id(req.clientId)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    avatar = req.avatar.strip()[:240]
    if not (avatar.startswith("/avatars/") or avatar.startswith("/static/avatars/")):
        avatar = ""

    presence_users[client_id] = {
        "clientId": client_id,
        "handle": (req.handle.strip() or "Anonymous")[:32],
        "avatar": avatar,
        "activity": req.activity if req.activity in PRESENCE_ACTIVITIES else "online",
        "detail": req.detail.strip()[:80],
        "lastSeen": int(time.time() * 1000),
    }
    return _presence_snapshot()


@app.delete("/api/presence")
def delete_presence(clientId: str = Query(None)):
    if clientId:
        try:
            presence_users.pop(_presence_client_id(clientId), None)
        except ValueError:
            pass
    return _presence_snapshot()


# ── Static Files ─────────────────────────────────────────────

STATIC_DIR = Path(__file__).parent / "static"
AVATAR_SOURCE_DIR = Path(__file__).parent.parent / "avatars"
AVATAR_STATIC_DIR = STATIC_DIR / "avatars"


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/avatars")
def list_avatars():
    avatar_dir = AVATAR_STATIC_DIR if AVATAR_STATIC_DIR.exists() else AVATAR_SOURCE_DIR
    files = []
    if avatar_dir.exists():
        for idx, path in enumerate(sorted(avatar_dir.iterdir()), start=1):
            if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
                files.append({
                    "id": f"avatar-{idx}",
                    "file": path.name,
                    "url": f"/avatars/{quote(path.name)}",
                })
    return {"avatars": files}


if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

if AVATAR_STATIC_DIR.exists():
    app.mount("/avatars", StaticFiles(directory=str(AVATAR_STATIC_DIR)), name="avatars")
elif AVATAR_SOURCE_DIR.exists():
    app.mount("/avatars", StaticFiles(directory=str(AVATAR_SOURCE_DIR)), name="avatars")


def _status_color(s: str) -> str:
    return {"yes": "#30D56B", "queue": "#FF7A1A", "low": "#FFC400", "no": "#FF4D5A"}.get(s, "#8A94A6")


if __name__ == "__main__":
    print(f"\n  🚀 GdeBenz Bulk Voter → http://localhost:8585\n")
    uvicorn.run(app, host="0.0.0.0", port=8585, log_level="info")
