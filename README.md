# 📰 Autonomous Self-Healing News Aggregator Pipeline

An AI-driven, zero-maintenance news extraction pipeline that discovers live global articles using **Newsdata.io**, performs deep full-text extraction via **Puppeteer & Bright Data**, and autonomously repairs its own parsing selectors using the **Bright Data Scraper Studio CLI** when target website layouts change.

---

## 🚀 The Problem & Hackathon Pitch

* **The Problem:** Web scrapers are notoriously brittle. The moment a publisher shifts its HTML structure or renames a CSS class (**DOM Drift**), pipelines shatter, data turns into `undefined`, and developer time is burned on manual rewrites.
* **The Solution:** An **Autonomous Data Pipeline** that monitors its own data integrity. On structural failure it invokes an automated refactoring engine that re-crawls the target, infers a new parsing contract, verifies it against the live DOM, and hot-swaps the production selectors — with no code deployment and no server restart.

---

## 🛠️ Architecture & Tech Stack

```text
   [ Newsdata.io ] ────── (Gives Headline & Target URL) ─────► [ Node.js Backend Engine ]
                                                                      │
                                                                      ▼ (Spawns Browser)
   [ Web UI Dashboard ] ◄─── (Displays Self-Healed Data) ──── [ Bright Data Scraping Browser ]
             ▲                                                        │
             │ (Streams Terminal Code Patches)                        ▼ (If 'undefined' detected)
             +─────────────────────────────────────────────── [ Scraper Studio AI CLI ]
```

* **Upstream Discovery:** [Newsdata.io](https://newsdata.io) — live global metadata arrays and article URLs
* **Orchestration & UI:** Node.js, Express, Puppeteer Core, Cheerio, Server-Sent Events
* **Proxy & Browser Infrastructure:** [Bright Data](https://brightdata.com) Scraping Browser + Web Unlocker
* **AI Self-Healing Engine:** Bright Data Scraper Studio CLI with an embedded DOM-inference fallback

### Transport Fallback Chain

Every extraction walks this chain and uses the first transport that returns a rendered document:

1. `bright-data-scraping-browser` — Puppeteer connects over `SBR_WS_ENDPOINT`
2. `bright-data-web-unlocker` — `api.brightdata.com/request` with your zone
3. `local-chrome` — Puppeteer launches `CHROME_PATH`
4. `direct-origin` — plain HTTPS fetch

---

## 📂 Project Structure

```text
node-brightdata-demo/
├── public/
│   └── index.html       # Frontend Interactive Dashboard
├── server.js            # Express backend, transport chain, healing engine
├── selectors.json       # Hot-swappable live parsing contract
├── .env                 # Runtime keys (git ignored)
├── .env.example         # Template for collaborators
└── package.json
```

---

## ⚡ Quick Start

### 1. Prerequisites

[Node.js v18+](https://nodejs.org) and, optionally, the Bright Data CLI:

```bash
npm install -g @brightdata/cli
```

If the CLI is not authenticated or not on `PATH`, the pipeline transparently falls back to its embedded DOM-inference healer, so the demo never blocks.

### 2. Install Dependencies

```bash
npm install
```

### 3. Environment Configuration

Keys live in `.env`, never in source:

```ini
NEWSDATA_API_KEY=pub_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
BRIGHTDATA_API_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
BRIGHTDATA_ZONE=your_web_unlocker_zone_name
SBR_WS_ENDPOINT=wss://brd-customer-<id>-zone-<zone>:<password>@brd.superproxy.io:9222
BRIGHTDATA_COLLECTOR_ID=your_collector_id
GEMINI_API_KEY=your_gemini_key
ELEVENLABS_API_KEY=sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
ELEVENLABS_MODEL=eleven_multilingual_v2
ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128
```

`BRIGHTDATA_ZONE` must match a zone that exists in your Bright Data control panel. Until a zone is created, the pipeline logs the rejection and drops to the next transport automatically.

Narration runs on ElevenLabs text-to-speech: `ELEVENLABS_API_KEY` is required for the **Listen** button, and `ELEVENLABS_VOICE_ID` can be any voice from your ElevenLabs voice library.

### 4. Fire Up the Server

```bash
npm start
```

Open **http://localhost:3000**

---

## 📺 The Winning 3-Step Live Demo Storyline

1. **The Fresh Discovery** — Click **Load Fresh Newsdata.io Stories**. Newsdata.io returns clean JSON headlines and URLs, but no full body text — useless for LLM training or content generation on its own.
2. **Healthy Deep Extraction** — Click **Extract Full Text** on a story card. The backend routes through Bright Data, extracts the body, and the dashboard reports `HEALTHY`, the matched selector, word count and transport used.
3. **The Climax** — Click **Simulate Selector Drift**, then re-extract. The parser returns `null` / `undefined` and the banner flips to `DOM_DRIFT_DETECTED`. Click **Heal With Scraper Studio AI**: the terminal streams the `bdata scraper heal` invocation, candidate-container scoring, the verified patch, and the generated JavaScript parser. Click **Approve & Hot-Swap** to run the `bdata scraper approve <token>` flow, bump `selectors.json` to the next generation, and re-extract healthy data — with the server still running.

---

## 🔌 API Surface

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/status` | Live profile version, metrics, transports, drift state |
| `GET` | `/api/stream` | SSE feed powering the dashboard terminal |
| `GET` | `/api/news?q=` | Newsdata.io discovery |
| `POST` | `/api/extract` | Deep extraction + integrity verdict |
| `POST` | `/api/drift` | Toggle the simulated publisher layout change |
| `POST` | `/api/heal` | Generate and stage a verified patch |
| `POST` | `/api/approve` | Hot-swap the live selector profile |
| `POST` | `/api/rollback` | Reset to the baseline profile |

---

## 🔐 Security Notes

* All credentials load from `.env`, which is git-ignored; `.env.example` is the shareable template.
* `/api/extract` and `/api/heal` validate every target URL: scheme allow-list plus DNS resolution checks that reject loopback, link-local, and RFC1918 addresses, closing the SSRF hole inherent to user-supplied crawl targets.
* All UI-rendered values are HTML-escaped before injection into the dashboard.

---

## 🏆 Key Hackathon Metrics & Business ROI

* **Time to Resolution:** Selector fix lifecycles drop from ~45 minutes of manual debugging to a sub-second autonomous heal, measured live and shown in the dashboard metrics panel.
* **Maintenance Overhead:** Removes the on-call loop for structural parser breakage.
* **Zero-Downtime Patching:** `selectors.json` is re-read per extraction, so approved patches go live without a restart.
