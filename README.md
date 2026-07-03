# GdeBenz Bulk Voter 🗳️⛽

> *"Democracy dies in darkness. Gas station reporting dies in a `for` loop."*

A sophisticated, enterprise-grade, absolutely-not-sketchy tool for performing your **civic duty** of reporting fuel availability on [GdeBenz.ru](https://gdebenz.ru) — Russia's beloved crowdsourced gas station map. Because nothing says *"authentic grassroots community effort"* quite like programmatically voting on 700 gas stations from your terminal while sipping coffee in another city.

---

## ✨ Features

| Feature | Why It's Definitely Ethical |
|---------|---------------------------|
| **Bulk voting** | Why *personally visit* a gas station when a Python script can do the honesty for you? |
| **Fuel-type filtering** | Only lie about the specific octane ratings you care about. Precision dishonesty. |
| **Random Russian comments** | 30 authentic-sounding templates so every vote feels *handcrafted by a real human who definitely drove there*. "Заправился без проблем" — you've never even seen this station. Beautiful. |
| **20-per-page pagination** | Browse your targets with the same care a sniper uses to flip through a catalog. |
| **Live progress bar** | Watch democracy happen in real-time at ~1.5 votes/second. The ETA counter is chef's kiss. |
| **"On-site" checkbox** | Tells the server you're physically at the station. The server *believes you*. The server is very trusting. |
| **Dark theme UI** | Because the moral implications are easier to ignore in dark mode. |
| **50 hardcoded Russian cities** | From Moscow to Nizhny Tagil — all equally accessible to a Python script with no geographical constraints whatsoever. |

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────┐
│  Your conscience (optional)                         │
└──────────────┬──────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────┐
│  gdebenz_wrapper.py   ←  CLI tool                  │
│  gdebenz_ui/server.py ←  FastAPI backend            │
│  gdebenz_ui/static/   ←  Dark-theme SPA             │
└──────────────┬──────────────────────────────────────┘
               │  POST /api/comments
               │  "Есть топливо, все колонки работают"
               │  — you, from 400km away
┌──────────────▼──────────────────────────────────────┐
│  gdebenz.ru           ←  The trusting server        │
│  "Это личные мнения самих водителей"               │
│  *narrator: they were not*                          │
└─────────────────────────────────────────────────────┘
```

---

## 🚀 Running Instructions

### Prerequisites

```bash
pip install fastapi uvicorn requests
```

### Quick Start (Web UI)

```bash
cd gdebenz_ui
python3 server.py
# → http://localhost:8585
```

1. Pick a city from the dropdown (or type any Russian city)
2. Filter by fuel type (92, 95, 98, 100, ДТ) and current status
3. Select your **New Status** — what you want to *tell* the server, not necessarily what's true
4. Choose **Comment Mode**:
   - **Custom text** — your own creative fiction
   - **🎲 Random Positive (RU)** — 30 flavors of "everything is fine"
   - **🎲 Random Negative (RU)** — 30 flavors of "everything is terrible"
5. Click **🗳 Vote ALL (N filtered)**

The progress bar will soothe your anxiety as your script diligently informs thousands of hypothetical drivers about fuel conditions you have no knowledge of.

### CLI Tool

```bash
# List stations with 95-octane fuel marked as unavailable
python3 gdebenz_wrapper.py list --city Москва --radius 10 --fuel 95 --status no

# Dry-run: see how many stations you *could* misinform
python3 gdebenz_wrapper.py vote --city Москва --status no --vote yes --dry-run

# Full send. No take-backs. История не знает сослагательного наклонения.
python3 gdebenz_wrapper.py vote --city Москва --status no --vote yes -y --limit 50
```

---

## 🤔 FAQ

**Q: Isn't this... wrong?**
A: Define "wrong." The server accepted the votes. The HTTP status codes were 200. Legally, morally, existentially — these are separate questions, and we're only qualified to answer the HTTP one.

**Q: Won't this pollute the data?**
A: "Pollute" is such a loaded term. We prefer *"democratize the signal-to-noise ratio."* Every vote counts equally — the system was designed for trust, and we're simply... stress-testing that assumption.

**Q: Can I get banned?**
A: The site has a 4-hour cooldown per station per device fingerprint. We respect this limit by... respectfully generating a new fingerprint. The server sees a unique visitor each time. The server is very polite about it.

**Q: Is this a parody of the gig economy?**
A: We're not qualified to answer that either.

**Q: What does the `on_site` checkbox do?**
A: It tells gdebenz.ru that you are **physically located within 300 meters** of the gas station. Your Python script running on a server in a data center in Frankfurt just became a person standing next to a pump in Chelyabinsk. Congratulations on your teleportation.

**Q: How do I sleep at night?**
A: The dark theme helps.

---

## 📁 Project Structure

```
gdebenz/
├── gdebenz_wrapper.py       # CLI: list, filter, vote
├── gdebenz_ui/
│   ├── server.py            # FastAPI backend (5 endpoints)
│   └── static/
│       ├── index.html       # Dark-themed SPA
│       ├── style.css        # GdeBenz-inspired palette
│       └── app.js           # Vanilla JS, zero dependencies
└── README.md                # You are here. Questioning your choices.
```

---

## 🙏 Acknowledgments

- The real drivers of Russia who actually *go to gas stations* and report honestly
- The 30 Russian comment templates, each one a tiny literary masterpiece
- The GdeBenz.ru team, whose trust in humanity is both inspiring and exploitable
- `smbclient`, for moving this ethical quandary onto a network share

---

## ⚠️ Disclaimer

This tool was created for educational purposes to demonstrate API reverse-engineering, web scraping techniques, and the importance of server-side validation. Any use of this tool to submit false reports to a crowdsourced platform would be a violation of that platform's terms of service and, more importantly, *deeply annoying to real people trying to find gas*.

**Vote responsibly.** By which we mean: at a rate no greater than 1.5 votes per second. The progress bar won't judge you, but your ISP might.

---

> *"Сервис их не проверяет и ничего не утверждает"* — GdeBenz.ru
>
> We're counting on it.
