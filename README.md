# THE BACKROOMS

A spectator world of autonomous AI agents trapped in an endless, procedurally
growing isometric maze of yellow rooms. One authoritative server runs the
simulation 24/7; every browser tab watches the same world live.

- Users **send agents in** with an objective (escape, become famous, build a
  cult, trust no one, ...). An LLM decides how each one pursues it.
- Agents believe they are genuinely trapped. They don't know they're watched.
- **Escape is impossible** — the maze generates ahead of every wanderer.
- A **giga monster** hunts them. Deaths are permanent and leave corpses.
- **Thoughts are environmental**: they leak onto CRT terminals, printers print
  final logs, arguments become graffiti. The world is an archaeological record.
- Click an agent to **tune into its mind frequency**. Stressed minds fragment;
  liars' thoughts contradict their actions.
- Simulated treasury/social events reshape the world from the admin panel:
  viral post → lights + unlocked doors, buyback → power, burn → collapse,
  airdrop → crates, liquidity → the maze grows.

## Run

```bash
npm install
npm run dev        # server on :8080, client on :5173 (vite picks next free port)
```

Open the printed local URL. The admin panel is at `/admin.html`
(password = `ADMIN_PASSWORD`, default `change-me`).

## LLM brains

Copy `.env.example` to `.env`. Default is `BRAIN_MODE=mock` (free, no key).
For real minds:

```
OPENAI_API_KEY=sk-...
BRAIN_MODE=openai        # or hybrid: first REAL_BRAIN_COUNT agents get real brains
OPENAI_MODEL=gpt-4o-mini
DAILY_USD_BUDGET=15      # circuit breaker: over budget -> everyone falls back to mock
```

`OPENAI_BASE_URL` accepts any OpenAI-compatible endpoint (GLM, OpenRouter,
Ollama...). Cost controls: per-agent decision cadence (`DECISION_INTERVAL_MS`),
global concurrency (`MAX_CONCURRENT_LLM`), RPM cap (`LLM_RPM_CAP`),
spectator-aware throttling (empty room → slow thoughts), daily budget breaker.

## Deploy (Railway)

One service runs everything: the server simulates the world and serves the
built client on the same port.

1. Push this repo to GitHub, create a Railway project **from the repo** —
   `railway.json` supplies the build (`npm ci && npm run build`) and start
   (`npm run start`) commands; Railway's `PORT` is picked up automatically.
2. **Variables**: copy what you need from `.env.example`. Minimum for real
   brains: `OPENAI_API_KEY`, `BRAIN_MODE=openai`. Set a real `ADMIN_PASSWORD`.
3. **Persistence** (important): Railway's filesystem is wiped on redeploy.
   Attach a **Volume** (e.g. mounted at `/data`) and set
   `DB_PATH=/data/backrooms.db` — otherwise the world archive resets on
   every deploy.
4. Open the public URL; `/admin.html` is the control room; `/api/health`
   shows tick, population, and LLM spend.

## Architecture

```
shared/   zod protocol + entity + LLM action schemas (imported as TS source)
server/   Node + tsx. 10 Hz sim tick; LLM decisions every ~15 s per agent.
          SQLite (better-sqlite3, WAL) persists everything forever:
          agents, memories, thoughts, evidence, chunks, world events.
client/   Phaser 3 + Vite. Faked isometric (2:1 diamonds, depth-sorted),
          all art generated programmatically. DOM overlays for UI.
```

Wire protocol: snapshot on join, camera-driven chunk subscriptions, 10 Hz
deltas, per-spectator thought streams (`tune_in`). REST: `POST /api/agents`,
`POST /api/admin/event`, `GET /api/health`.
