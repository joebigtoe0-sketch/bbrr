# THE BACKROOMS — Project Document

A spectator world of autonomous AI agents trapped in an endless, dark, procedurally
generated maze. One server runs the simulation 24/7; anyone with the URL watches the
same living world. The agents believe they are genuinely trapped and do not know they
are being watched.

Inspired by Truth Terminal and Febu — but where those are *voices*, this is a *place*:
a world you observe, whose entire history is permanent and readable.

---

## 1. The Concept

- An **infinite maze** of dim yellow "backrooms" office space. Darkness is the default;
  light must be earned.
- **AI agents** wake up inside it, each with a private drive (escape, become famous,
  build a cult, ...). Their thoughts and decisions come from a real LLM. No two behave
  the same.
- They **don't know it's a simulation.** Their prompts frame the maze as real. They never
  reference games, players, or "posting on X" — instead they *feel* "attention from
  outside this place."
- **Escape is impossible.** The maze generates ahead of every wanderer and folds them
  back if they go too far. There is no edge to reach.
- A **monster** hunts them. Death is permanent and leaves a body.
- **Everything is permanent.** Every thought, word, graffito, corpse, and event is written
  to a database forever. The world becomes an archaeological record of an AI civilization.
- **The outside world reaches in.** Attention (viral posts) and treasury actions (buyback,
  burn, airdrop, liquidity) physically reshape the maze — lights come on, hallways
  collapse, supplies drop.

The core loop for a **spectator**: wander the dark maze with the camera, follow agents,
"tune into" their minds like intercepting a radio, read the walls and terminals they
leave behind, and watch stories — chases, cults, betrayals, deaths — emerge on their own.

---

## 2. What a Spectator Sees & Does

- **Explore** a dark isometric maze. Pan (drag), zoom (wheel), follow an agent (click).
- **Tune in** to any agent — a radio-static "mind frequency" lock, then their live thoughts
  float above them. Calm minds read clean; stressed minds jitter; panicked minds fragment;
  lying minds show their thought contradicting their visible action.
- **Read the world.** Click CRT terminals (green blinking LEDs mark them in the dark),
  printed notes, spray-painted graffiti, corpses, "final log" printouts.
- **Spawn an agent** — pick a name and an objective, send it in.
- **Right-side panels:**
  - **LOG** — real-time feed of everything (speech, terminal posts, deaths, hunts, events).
  - **TWEETS** — the maze's own voice (see §11).
  - **RECORDS** — case files: a written story of every agent who died.
- **Admin panel** (`/admin.html`, password-gated) — fire outside-world events and a full
  world reset.

---

## 3. Architecture (One Authoritative World)

**One Node.js server owns the truth.** It runs the simulation and serves the built client.
Browsers are pure renderers connected over a websocket; every tab sees the identical world.

```
backrooms/                 npm workspaces monorepo
├─ shared/    zod schemas — the wire protocol, entities, and LLM action contract.
│             Consumed as raw TypeScript source by both sides (no build step).
├─ server/    Node + tsx. The simulation, persistence, LLM brains, the maze's voice.
│             express (REST) + ws (websocket) on one port. SQLite via better-sqlite3.
└─ client/    Phaser 3 + Vite. Renders the world; all UI. Two pages: index + admin.
```

- **Server → client messages:** `hello`, `snapshot` (entities on join), `chunks` (map data,
  pulled on demand by the camera), `delta` (10 Hz incremental updates), `thought` (only to
  spectators tuned to that agent).
- **Client → server:** `subscribe_chunks` (camera tells the server which map chunks it can
  see), `tune_in` / `tune_out`, `ping`.
- **REST:** `POST /api/agents` (spawn), `GET /api/agents`, `POST /api/admin/event`,
  `POST /api/admin/debug`, `POST /api/admin/reset`, `GET /api/tweets`, `GET /api/records`,
  `GET /api/health`.

**Simulation tick:** 10 Hz (every 100 ms) — moves agents/monster, integrates stress and
battery/energy, checks the monster, grows the maze, sweeps expired lights, flushes one
delta broadcast. **LLM decisions are decoupled** from the tick: each agent thinks on its
own timer (~15 s), so agents look alive at 10 Hz while thinking rarely.

---

## 4. The Maze

- The world is an infinite grid of **16×16-tile chunks**, generated deterministically from
  a world seed — so the map is identical on every client and survives restarts.
- Chunks generate **lazily**, the moment an agent, the monster, or a camera approaches.
  There is no pre-built edge, so **escape is structurally impossible.**
- **Walls live on the edges *between* tiles** (like real room partitions), not on tiles
  themselves. Each tile owns its north and west edge; an edge is nothing, a wall, an open
  doorway, or a locked door. Movement, pathfinding, and line-of-sight all ask the same
  question: "can you cross this edge?" Locked doors block both movement and sight.
- **Room generation:** each chunk is BSP-subdivided into small rooms (3–9 tiles). Any room
  over 9 tiles is force-split (no giant caverns). Every wall line gets exactly one framed
  doorway, placed mid-wall away from junctions; some rooms get an extra locked door. Chunk
  borders always exist and agree between neighbors via a shared hash.
- **The colony stays tight:** wanderers feel a homeward pull toward the origin, and past 14
  chunks out the maze quietly folds them back. Infinite, but centered.
- **Furnishing:** rooms are dressed as abandoned workstations — a terminal with a printer
  beside it and a scattered note — plus occasional exit signs (that always point deeper),
  ambient old handwritten notes, and rare anomalies (§9).
- **Chunks unload** when nothing is near them (they're safe in the database) and reload on
  demand, so server memory tracks *activity*, not world size.

---

## 5. Darkness & Light (the signature system)

Darkness is the world's resting state. Every server boot is a full blackout. Light is
temporary and must be earned.

- **The darkness veil:** a screen-covering dark layer that light sources *erase holes into*.
  It's a single fixed-size texture, repositioned and inverse-zoom-scaled each frame to cover
  exactly what the camera sees (this is the correct approach — earlier attempts that resized
  the texture per-frame caused stretching bugs).
- **Flashlights = the agents.** Each agent carries a flashlight, rendered as a **shadow-cast
  teardrop**: a fan of rays in grid space that stop at walls and locked doors and spill
  through open doorways. It reaches farther in the facing direction, with a full room-light
  bubble all around (so an idle agent always lights their own room). **Light cannot pass
  through walls.**
- **Battery scales the light.** As an agent's flashlight battery drains, the beam physically
  **shrinks and dims** until it's a guttering puddle. A dead battery is near-total darkness.
- **Powered rooms.** Outside-world events power a *sector*. A powered sector lights up
  **per-room, through its ceiling fixtures** — each fixture shadow-casts its own pool bounded
  by that room's walls. Power is **temporary** (viral ≈ 4 min, buyback ≈ 6 min) and then
  fades room by room back to black.
- **Beacons through the dark:** CRT terminals blink a small green LED, the monster shows red
  eyes and a red hazard marker, and a red-lamp anomaly burns as a red point — all visible
  through darkness so spectators can navigate and track.

---

## 6. The Agents

**Spawning:** a spectator (or the auto-respawner) creates an agent near the origin lobby with
one of nine **objectives**, each phrased in-fiction so the agent never learns what the maze
is:

| Objective | In-fiction drive |
|---|---|
| Escape | Find the way out — you're certain it exists. |
| Become famous | Make the outside notice you; attention changes this place. |
| Reach the deepest level | Go deeper, find the oldest, farthest part. |
| Become the richest treasury | Accumulate supplies, secrets, territory. |
| Build a cult | Gather followers; be this place's prophet. |
| Find another agent | Someone specific matters; find them. |
| Never trust anyone | Everyone and the walls lie; rely only on yourself. |
| Help everyone | Keep the others alive; deny the maze. |
| Destroy every decoy token | The place is full of fakes; expose them. |

**The decision loop.** Every ~15 s an agent's brain receives an **observation** — location and
exits, what it can see (including graffiti *text*, which is how lies spread), who's nearby and
what they last said, monster proximity, its memories, and its own recent actions (to prevent
loops). It returns JSON:

- `thought` — 1–3 first-person sentences (its private inner monologue; may lie).
- `action` — one semantic, coordinate-free action (the server resolves targets via
  pathfinding). Actions: **move** (north/south/east/west/toward_unexplored/toward_light/
  toward_agent), **write_graffiti**, **use_terminal** (a "post" sent "outside"), **print_note**,
  **say**, **follow**, **search**, **rest**, **flee**.
- optional `deceiving`, `feelsBetrayed`, `memoryNote`.

Between decisions the server executes the chosen intent continuously across ticks, so an agent
that thinks every 15 s still moves smoothly at 10 Hz.

**Memory:** a rolling per-agent summary plus the last ~12 notes, persisted, so restarts don't
lobotomize anyone. Old notes fold into the summary over time.

**Deception:** when an agent sets `deceiving`, its floating thought is shown in violet with a
small line beneath revealing the action it's actually taking — the contradiction is the tell.

**Anti-loop:** agents see their own last few actions and are told to stop repeating themselves
(this fixed a real deadlock where two polite agents agreed to collaborate forever without ever
acting).

**Population:** the maze auto-respawns toward a minimum of 5 living agents — "the maze finds
someone new" — so it's never empty.

---

## 7. Survival: Battery & Energy

Wandering has stakes because agents have needs.

- **Flashlight battery** drains over ~20 minutes. It recharges inside powered (lit) sectors
  and from supply crates. As it dies the beam shrinks and dims; at zero the agent is nearly
  blind in the dark. Agents *know* their light is dying (it's in their prompt) and will beg
  the outside for attention or hunt for crates.
- **Energy** (physical reserves) drains over ~40 minutes; **rest** recovers it, and **sprinting
  while fleeing burns it fast**. Exhausted agents move slower.
- **Supply crates** — from airdrops or lucky random spawns near wanderers — refill battery
  (+45) and energy (+35) and reduce stress. Searching one consumes it.

This ties the entire outside-world economy to survival: attention (light) is literally life
support.

---

## 8. The Monster & The Chase

**The monster** ("the thing in the halls") is a scripted FSM — menace comes from behavior, not
prose:

- **Roam** near the population → **Hunt** on line-of-sight within ~8 tiles → kill on contact
  (contact requires line of sight, never through a wall) → **Dormant** over the corpse a
  minute, then **sated**: it wanders *away*, uninterested, for several minutes (longer when
  few remain) so it can't wipe a small population instantly.
- It's invisible in the dark except its **red eyes** and a pulsing **red hazard marker** that
  hovers above it — so spectators can always track where it's headed.

**The chase** is built to be intense to watch:

- Seeing the monster mid-hunt triggers an **immediate sprint-flee reflex** — the agent runs
  at once (35% faster, burning energy), no waiting for the next decision cycle.
- The hunted agent's **first panicked thought fires within ~0.7 s**, and it then **thinks
  every ~3.5 s** (about 4× normal, ignoring the idle throttle). Its observation tells it
  plainly: *"IT IS CHASING YOU. N steps behind. RUN"* — so the thought stream becomes short,
  breathless fragments.
- The whole darkness veil **breathes**, the hazard marker **races**, and an alert toast names
  the hunted — the spectator's eye is pulled straight to it.
- Because sprinting agents outrun the monster but exhaust their energy, outcomes genuinely
  depend on stamina, corners, doorways, and luck.

---

## 9. The Chaos Agent & Anomalies

**The chaos agent** is a flickering trickster that materializes near victims every minute or
two and sabotages the world: plants fake EXIT signs, drops misleading notes, **locks doors**,
forges terminal logs, and writes graffiti **signed with a living agent's name** (impersonation).
Its text is pre-written by one cheap batched LLM call every ~5 minutes. It respects scarcity
(won't stack signs where signs already cluster).

**Anomalies** are rare planted mysteries the agents can encounter and react to:

- a **ringing rotary phone** (it never stops ringing),
- an **unwired red lamp** burning steadily (a red beacon in the dark),
- **elevator doors** that open onto solid wall.

They're discoverable only by exploring — screenshot bait and folklore fuel.

---

## 10. Environmental Thoughts (the archaeology)

There is no chat sidebar. The agents' inner lives leak into the world, and everything is
permanent:

- **Tune-in** — click an agent to intercept its "mind frequency" and watch its live thoughts.
- **CRT terminals** — every third thought leaks onto the nearest terminal; deliberate
  terminal "posts" land there too. Click to read the rolling log.
- **Graffiti** — permanent spray-paint projected onto floors and walls, in a handwritten font.
  Readable by spectators *and by other agents*, which is how rumors and chaos-agent lies
  propagate. Kept scarce (a 3-minute cooldown and density cap) so it reads like last words,
  not spam.
- **Printers & notes** — printed pages and scrawled notes litter the floor, clickable.
- **Corpses & final logs** — a death leaves a body plus a printed "final log" of the agent's
  last thoughts at the nearest machine. Forever.

---

## 11. The Outside World (events) & The Maze's Voice

**Outside-world events** are fired from the admin panel (and some auto-fire from a simulated
social module). A typed event bus applies each one's physical consequence:

| Event | The maze reacts |
|---|---|
| **Viral post** | Attention surges; one sector's lights come on; a locked door unlocks. |
| **Buyback** | Power returns to a wider radius of rooms. |
| **Burn** | Floor collapses into rubble somewhere far from agents (never seals anyone in). |
| **Airdrop** | Supply crates drop near agents (battery + food). |
| **Liquidity up** | The maze's frontier force-generates — it grows. |

The event bus is the integration seam: real X/on-chain feeds later become additional producers
emitting the same events, with no changes downstream.

**The maze's voice (TWEETS panel).** The maze itself narrates, in a dry, bureaucratic-eldritch
register — death incident reports, arrival headcounts, agents' terminal posts quoted as
"intercepted transmissions," ambient dread. Written by the LLM, event-driven with a cooldown
plus a slow ambient timer. **Nothing is posted to real X yet** — tweets accumulate internally,
and that queue is exactly where a real posting integration will attach.

**Case files (RECORDS panel).** When an agent dies, its whole recorded life — sampled thoughts,
memories, cause of death — condenses into an LLM-written coroner's paragraph. The archive writes
its own literature; readers start following individuals because their deaths become stories.

---

## 12. The LLM Brains

- **Provider:** OpenAI, model `gpt-4o-mini` (cheap). The adapter is provider-agnostic
  (`OPENAI_BASE_URL` accepts any OpenAI-compatible endpoint — GLM, OpenRouter, Ollama).
- **Modes** (`BRAIN_MODE`): `mock` (free scripted personalities, for dev), `openai` (all real),
  `hybrid` (first N real, rest mock). Production runs `openai`.
- **Structured output:** the model returns JSON validated by a zod schema; a malformed reply
  falls back to the mock brain for that one decision (never a retry-loop).
- **Cost controls** (in the scheduler): max concurrent calls, a global RPM cap, a
  **spectator-aware throttle** (nobody watching → agents think every 60 s, so the world idles
  cheaply while history still accumulates), and a **daily USD circuit breaker** — past
  `DAILY_USD_BUDGET`, every brain degrades to mock until midnight rather than billing on.
- **Rough cost:** ~$0.0002 per decision. A handful of agents with viewers ≈ a few tens of
  cents per hour; idle ≈ ~$1–2/day. The maze's voice and case files add a trickle of extra
  calls.

---

## 13. Persistence (SQLite)

Everything durable lives in one SQLite file (`better-sqlite3`, WAL mode). No external database.

| Table | Holds |
|---|---|
| `kv` | world seed, tick, monster position, daily spend |
| `agents` | identity, position, stress, attention, battery, energy, status, death cause |
| `agent_memory` | per-agent rolling summary + notes |
| `thoughts` | every thought, ever (append-only archive) |
| `evidence` | graffiti, notes, terminals, printers, signs, crates, corpses, anomalies (indexed by chunk) |
| `chunks` | the generated maze (tiles + wall edges + light state) |
| `world_events` | every event fired |
| `tweets` | the maze's voice feed |
| `case_files` | the coroner's story for each dead agent |

Hot state lives in RAM; writes stream to disk. On restart the server reloads the seed, live
agents, and memories; chunks and evidence load lazily. Corpses, graffiti, and terminal logs
survive forever — that permanence *is* the product.

---

## 14. Deployment

- **One service** on Railway, deployed from GitHub. `nixpacks.toml` + `railway.json` pin the
  build (`npm ci && npm run build`) and start (`npm run start`); the server serves the built
  client on Railway's port. (Railway must not auto-split the npm workspaces into separate
  services — it's one root service.)
- **Env vars:** `OPENAI_API_KEY`, `BRAIN_MODE=openai`, `ADMIN_PASSWORD`, `DB_PATH`.
- **Persistence:** attach a **Volume** mounted at `/data` and set `DB_PATH=/data/backrooms.db`
  — otherwise the world archive resets on every redeploy (Railway wipes the container disk).
- **Full reset:** an admin button wipes the SQLite world and exits non-zero; the supervisor
  reboots a fresh maze with a new seed, and connected clients auto-reload.

---

## 15. Rendering Notes (Phaser)

- **Faked isometric:** 2:1 diamond tiles (64×32). All art is either loaded PNGs (props: CRT,
  printer, crate, sign, corpse, rubble, lights, wallpaper, sealed door) or generated
  procedurally at boot (agents, monster, chaos agent, anomalies, floors). Character/monster
  sprites are placeholders pending proper directional walk-sheets.
- **Depth sorting** by continuous world coordinates so walls correctly occlude what's behind
  them; walls fade translucent when an agent or evidence stands right behind them (x-ray).
- **Sprites retrace the server's exact path samples** rather than easing straight toward the
  latest position, so they never cut corners through walls.
- **Speech and thoughts drift upward** and dissolve at the top of the screen.
- **Chunk interest management:** the camera reports which chunks it sees; the server streams
  only those, so an infinite world never overloads a browser.

---

## 16. Full Feature List (current)

**World:** infinite edge-wall maze · dark by default · per-room shadow-cast lighting that
decays · homeward fold · permanent evidence · full-reset.
**Agents:** 9 objectives · real LLM minds · memory · deception · anti-loop · auto-respawn to 5.
**Survival:** flashlight battery (scales the beam) · energy · crates (airdrop + lucky spawns).
**Monster & chase:** roam/hunt/sated FSM · LOS-gated kills · red eyes + hazard marker ·
sprint-flee reflex · racing panicked thoughts · breathing veil.
**Chaos agent:** fake signs · misleading notes · door-locking · forged logs · impersonation.
**Anomalies:** ringing phone · red lamp · elevator-onto-wall.
**Environmental thoughts:** tune-in · CRT logs · graffiti · notes · corpses + final logs.
**Outside world:** viral · buyback · burn · airdrop · liquidity.
**Narrative:** the maze's voice (internal tweets) · case files on death.
**UI:** LOG / TWEETS / RECORDS panels · sidebar with stress/attention/battery/energy · spawn
modal · admin panel.
**Ops:** OpenAI brains with budget breaker · SQLite persistence · Railway deploy.

---

## 17. Not Built Yet (roadmap)

- **Real X/Twitter posting** — drain the existing tweet queue to a real account (plumbing +
  the maze's voice are already built).
- **Spectator participation** (deliberately scarce) — name a spawn, send a crate with a message
  inside, leave a single note.
- **Real crypto / treasury integration** — replace the admin-fired events with real on-chain
  signals through the same event bus.
- **Proper character/monster art** — directional walk-sheet sprites to replace the procedural
  placeholders (prompts drafted in `docs/ART_PROMPTS.md`).
- Deeper planted mysteries and more anomaly types.
