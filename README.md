# Stringer

**A news pipeline that repairs its own scrapers.**

Built for [Into the Scrape-Verse](https://www.wemakedevs.org/hackathons/scrape-verse) (WeMakeDevs × Bright Data, August 2026).

Stringer discovers live news, extracts full article text with a custom Bright Data Scraper Studio collector, and — when a publisher's markup defeats that collector — repairs itself from a plain-language description of what broke. The repaired collector keeps its ID, so nothing downstream ever sees a gap. The structured output then feeds a summariser, an 18-language translator, and a text-to-speech news channel.

---

## The problem

Every scraping tutorial ends when the scraper runs. Real scrapers end when a site changes a class name and the pipeline starts returning `null` — quietly, at 3am, with no error and no alert. Someone notices a week later when the dashboard is empty.

News aggregation makes this worse than usual. There is no single site to maintain a scraper for. There are thousands of publishers, each with its own markup, and the feed hands you a new one whenever a story breaks somewhere unexpected. A scraper built for one publisher is, by construction, broken for the next.

## The approach

Stringer treats extraction failure as a normal event with an automatic response, rather than an exception with a human on the other end.

1. **Discovery** — Newsdata.io returns live stories and their URLs.
2. **Extraction** — a Scraper Studio collector pulls `headline`, `author`, `publish_date`, `article_body`.
3. **Drift detection** — output is checked before it is trusted. Missing headline, absent body, or under 250 characters marks the run `COLLECTOR_DRIFT`.
4. **Repair** — one of two paths, chosen automatically:
   - The publisher already has a collector → `bdata scraper heal` rewrites the extraction, staged for approval.
   - The publisher has no collector → `bdata scraper create` builds one dedicated to that domain.
5. **Delivery** — clean records drive summaries, translations, and audio.

The distinction in step 4 is the design decision the project rests on. Healing a collector against a domain it was never built for would degrade it for the domains it already handles. So Stringer grows a fleet — one collector per publisher, named `stringer-<hostname>` — and heals each only against its own domain.

---

## Self-healing, demonstrated

`POST /api/simulate` is the honest version of a broken-scraper demo. It asks Newsdata.io for the live feed, filters to publishers this collector has never successfully extracted from, and points the collector at them until one fails. Nothing is staged and nothing is hardcoded — the failing publisher differs every run, because the feed does.

What that produces:

```
warn   pointing collector c_8f2a91 at citizen.co.za, a publisher it was never trained on
error  collector returned no usable data for citizen.co.za, fields came back null
```

The heal prompt is then generated from the observed failure, naming the fields that came back null and the URL they failed on:

```
On https://citizen.co.za/news/... this scraper returns headline and article_body as null.
Update the extraction so those fields are captured on citizen.co.za article pages,
and leave fields that already work on other pages unchanged.
The heal is done when headline and article_body are non-empty for the URL above;
author may stay null.
```

Scraper Studio's progress streams into the UI as it works, and the repaired template is committed automatically — a patch left uncommitted would leave the collector broken, so approval is part of healing rather than a second decision. The collector ID before the heal and after it is the same value — see `samples/04-heal-patch.json` and `samples/05-extraction-recovered.json`.

---

## Structured output

A healthy extraction:

```json
{
  "url": "https://abbynews.com/2026/08/21/iio-investigating-williams-lake-incident...",
  "collectorId": "c_mt47g7832h7g3f8ktk",
  "status": "HEALTHY",
  "article": {
    "headline": "IIO investigating Williams Lake incident that left woman seriously injured",
    "author": "By Laísa Condé/Williams Lake Tribune",
    "published": "Published 2:56 pm Friday, August 21, 2026",
    "content": "...",
    "stats": { "characters": 1793, "words": 285 }
  },
  "healable": false,
  "durationMs": 9004
}
```

The same shape with `status: "COLLECTOR_DRIFT"`, `healable: true`, and null fields is what triggers a repair.

### Captured stages

Every stage of a real run is committed in [`samples/`](samples/), captured from a live pipeline rather than written by hand. API keys are redacted; Bright Data collector IDs are published deliberately, since they are the proof of work.

| File | Produced by | Shows |
| --- | --- | --- |
| `01-discovery.json` | `GET /api/news` | Newsdata.io discovery feed, normalised |
| `02-extraction-healthy.json` | `POST /api/extract` | Structured article output, collector working |
| `03-extraction-drift.json` | `POST /api/simulate` | The collector failing on a publisher it was never built for |
| `04-heal-patch.json` | `POST /api/heal` → `bdata scraper heal` | Scraper Studio rewriting the extraction, committed automatically |
| `05-extraction-recovered.json` | `POST /api/extract` | Same collector ID, same shape, data flowing again |
| `06-summary.json` | `POST /api/summarize` | What the structured output powers downstream |

Two collector IDs appear across those files, and the difference is the point:

- `03` runs one publisher's collector against a **different** publisher, which is how drift is induced on demand instead of waiting for a real site change. Every field comes back null.
- `04` and `05` repair the failing publisher's **own** collector. That ID is identical before and after the heal — the template changed underneath a live endpoint, and nothing downstream was touched or redeployed.

`04` carries `"approved": true`, so the rewritten template was committed rather than left staged. `05` is that same collector re-run, returning 285 words where it previously returned nothing.

---

## Downstream

Structured output is only worth having if something consumes it. Stringer's collectors feed:

- **Summarisation** — Gemini returns a schema-constrained headline and four-sentence summary, with compression ratio reported against the source.
- **Translation** — 18 languages, always re-translated from the English original rather than chained through a previous translation.
- **Broadcast** — ElevenLabs renders summaries to audio. `/api/channel` briefs up to ten stories into anchor-style segments and plays them as a continuous bulletin, with the anchor's mouth driven by a live analyser node on the audio stream.

---

## Architecture

```
Newsdata.io ──► discovery ──► Bright Data Scraper Studio collector ──► structured JSON
                                        │                                    │
                            drift detected? │                                    ▼
                                        ▼                              Gemini: summarise
                          bdata scraper heal / create                  Gemini: translate
                                        │                              Gemini: TTS
                                        ▼                                    │
                              same collector ID ◄───────────────────────────┘
```

Node.js and Express, no build step, no database. Server-sent events stream the pipeline log to the browser live, which is what makes the healing visible rather than something you read about afterwards.

The Bright Data CLI is invoked as a child process with arguments passed as an array — never through a shell — and every outbound call carries a timeout. CLI failures are translated into specific, actionable messages: a refactor already in progress, a concurrent-job cap, a job that can no longer be approved, and a polling timeout are each distinguished rather than collapsed into "something went wrong".

### Layout

```
server.js                  pipeline, CLI orchestration, HTTP API
public/index.html          dashboard, live log, news channel
samples/                   example structured output, stage by stage
```

### API

| Route | Purpose |
| --- | --- |
| `GET /api/status` | Collector registry, metrics, which integrations are configured |
| `GET /api/stream` | Server-sent event log |
| `GET /api/news` | Newsdata.io discovery |
| `POST /api/extract` | Run the collector for a URL |
| `POST /api/simulate` | Find a publisher that breaks the collector |
| `POST /api/heal` | Heal the collector and commit the patch, or build one if the publisher has none |
| `POST /api/summarize` | Summarise the last extraction |
| `POST /api/translate` | Translate the last summary |
| `POST /api/speak` | Voice the last summary |
| `POST /api/channel` | Brief several stories as broadcast segments |

---

## Setup

Requires Node.js 18 or later.

```bash
git clone <repository-url>
cd Stringer
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Required | Notes |
| --- | --- | --- |
| `BRIGHTDATA_API_KEY` | yes | From `npx -p @brightdata/cli bdata login` |
| `BRIGHTDATA_COLLECTOR_ID` | no | Optional `c_*` fallback. Leave blank and collectors are built on demand |
| `NEWSDATA_API_KEY` | yes | Free tier at newsdata.io |
| `GEMINI_API_KEY` | yes | Google AI Studio |
| `ELEVENLABS_API_KEY` | yes | ElevenLabs profile, for broadcast narration |
| `PORT` | no | Defaults to 3000 |
| `GEMINI_MODEL` | no | Defaults to `gemini-3.6-flash` |
| `ELEVENLABS_VOICE_ID` | no | Defaults to `JBFqnCBsd6RMkjVDRZzb` |
| `ELEVENLABS_MODEL` | no | Defaults to `eleven_multilingual_v2` |
| `ELEVENLABS_OUTPUT_FORMAT` | no | Defaults to `mp3_44100_128` |

If you have no collector yet, you do not need to create one. Extract or simulate
against any publisher and Stringer builds one for that domain on first contact,
naming it `stringer-<hostname>` and describing the fields itself. Creation takes
5-15 minutes.

To pre-seed one manually instead:

```bash
npx -p @brightdata/cli bdata login
npx -p @brightdata/cli bdata scraper create https://<publisher>/<article> \
  "Extract one record per news article page. Fields: headline, author, publish_date, article_body."
```

Name it `stringer-<hostname>` so Stringer's registry picks it up.

```bash
npm start
```

Open `http://localhost:3000`. On boot, Stringer loads every `stringer-*` collector on your account and reports how many it recovered.

### Try the healing loop

1. **Load stories** — pull the live feed.
2. **Simulate drift** — Stringer finds a publisher its collector cannot read and fails on camera.
3. **Heal** — watch Scraper Studio's steps stream in, then commit automatically.
4. **Extract again** — same collector ID, data flowing.

---

## Notes for reviewers

**Running costs money.** Every extraction consumes Bright Data credits and every summary consumes Gemini quota. `/api/heal` mutates collectors on your Bright Data account — the only side effect here that leaves your machine.

**No authentication.** Stringer binds all interfaces with open API routes and no rate limiting, which is fine on a laptop and wrong on a public host. Bind to `127.0.0.1` if that matters to you. Pipeline state is process-global, so it is single-user by design.

**Data sources.** Public news article pages only, discovered through Newsdata.io. No login-walled, paywalled, or government sites. Google News redirect URLs are filtered out of drift simulation because they are not publisher pages.

**AI assistance.** GitHub Copilot was used during development for scaffolding and refactoring. All architecture decisions, the collector-per-publisher model, the drift-detection thresholds, and the heal-versus-provision routing were designed and verified by hand.
