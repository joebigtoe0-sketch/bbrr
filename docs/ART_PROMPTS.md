# Sprite Asset Prompts — THE BACKROOMS: Found Footage Survival

Image-generation prompts for every asset, tuned to how the engine actually consumes
them. Style target = the key-art reference: **2D retro found-footage horror, isometric,
chunky pixel art, sickly fluorescent-yellow backrooms, VHS grain, a lone survivor with a
flashlight, a dark glowing-eyed entity.**

---

## 0. How sprites plug into the engine (read first — it constrains everything)

- **Projection:** 2:1 isometric. A full floor tile is a **64×32 diamond**. Characters/props
  are **billboard sprites** (flat, upright, not 3D-projected) that stand on that floor.
  Draw them as a ¾ top-down view, the same view as the reference character.
- **Anchoring:** every character/prop is **feet-anchored** — the pivot is bottom-center of
  the cell, the character's feet touch the bottom edge. Author with the feet at the same
  baseline in every frame so it doesn't bob.
- **Resolution:** author at **1× final pixel scale, nearest-neighbor, NO anti-aliasing,
  NO blur.** The game adds its own scanline/vignette/CRT post-processing on top, so the
  sprite art itself must be **clean** — no baked scanlines, no baked scene lighting, no
  background, no drop shadow, no text/labels/UI.
- **Background:** **transparent PNG.** If your generator can't do real alpha, request a
  **flat pure-magenta `#FF00FF`** (or pure black) background with no anti-aliased fringe so
  it keys out cleanly.
- **Lighting:** sprites are **flat/neutral-lit**. The world applies dynamic light per-tile,
  so a sprite baked with a hard light/shadow will look wrong in a dark room. Keep a soft
  even ambient; a faint top rim is fine.

### Facing & mirroring (why we only generate "front" and "back")

Movement happens along 4 screen diagonals. The engine mirrors horizontally, so you only
author two facings per character:

| Author this | Reused for (in-engine) |
|---|---|
| **Front** — ¾ view facing the camera, angled toward screen **lower-right** | walking down-right (East) + **mirror** → down-left (South) |
| **Back** — ¾ view facing away, angled toward screen **upper-right** | walking up-right (North) + **mirror** → up-left (West) |

So: **front-facing** = we see their face, they head toward the viewer-right.
**back-facing** = we see their back, heading away-and-right.

### Sprite-sheet format the loader expects

- One **horizontal strip** per animation (frames left→right), fixed cell size, transparent.
- Filenames match the in-engine texture key + animation + facing, e.g.
  `survivor_walk_front.png`, `survivor_walk_back.png`, `survivor_idle_front.png`.
- Loaded via Phaser `spritesheet(key, url, { frameWidth, frameHeight })`. Tell me the final
  frame counts and I'll wire the loader + animations; the current procedural textures stay
  as fallback until each real asset lands.

> **Tooling note.** General text-to-image models (Midjourney/DALL·E/SDXL) are great for
> **hero/concept frames** but unreliable at evenly-spaced sheets and true alpha. For actual
> game-ready **directional walk cycles**, use a pixel-sprite specialist —
> **PixelLab.ai**, **Retro Diffusion**, or Aseprite + an AI-assist — which output clean
> sheets with consistent baselines. The prompts below work in both; the per-frame
> breakdowns are written so a sheet tool can consume them directly.

---

## 1. SHARED STYLE BLOCK (paste before every prompt)

```
Retro pixel-art game sprite, 2D found-footage horror, isometric 2:1 dimetric ¾ view.
Chunky low-resolution pixels, crisp hard edges, NO anti-aliasing, NO blur, limited palette.
Sickly institutional "backrooms" mood but the sprite itself is neutral/flat-lit (the game
lights it later). Transparent background (or flat #FF00FF), single subject centered, full
body, feet at the bottom edge, no ground shadow, no scenery, no text, no scanlines, no UI.
Palette anchors: dirty fluorescent yellows #b8a44a #ad9a42, olive walls #9c8f45 #877b39,
cold shadows, pale fluorescent white #f5ffe8. VHS-era 90s survival-horror vibe.
```

---

## 2. CHARACTERS (animated — front + back sheets)

Character cell: **48×64 px**, feet centered on the bottom edge, ~4px headroom.
Deliver 4 sheets minimum each: `walk_front`, `walk_back`, `idle_front`, `idle_back`.

### 2a. Survivor (the user-spawned agent) — the hero asset

The reference character: a small, brave, doomed office-worker/urban-explorer with a
flashlight. The engine spawns many at once; **make variety come from a small roster of
distinct designs** (recommended over color-tinting one base — tinting muddies pixel art).
Generate the base survivor, then re-prompt swapping the outfit line for each roster entry.

**Base — front walk:**
```
[STYLE BLOCK]
A lone survivor character for an isometric backrooms horror game, ¾ front view facing the
camera and angled toward the lower-right. Ordinary young adult, short practical hair,
navy-blue short-sleeve shirt #3b5b8c, brown work trousers #6b4a2f, worn sneakers, holding a
small handheld flashlight forward in one hand (beam NOT drawn — the game renders the light).
Slightly hunched, nervous, tired. 48x64 px cell, feet at bottom center.
WALK CYCLE: 8 frames, left to right, one horizontal strip, smooth loop, consistent baseline,
gentle arm/leg swing, flashlight hand steady.
```

**Base — back walk:** same, but:
```
...¾ BACK view: we see the survivor's back and the back of their head, angled toward the
upper-right, walking away from the camera. Flashlight arm extended forward (away from us),
a faint cone-less glow implied only at the very edge. 8-frame walk strip.
```

**Idle front / idle back:**
```
...IDLE: 4 frames, subtle breathing + a small anxious glance, flashlight lowered slightly.
Minimal movement, same baseline. (Front version faces camera; back version faces away.)
```

**Optional — interact (4f):** kneeling/reaching at a terminal or scrawling on a wall.
**Optional — collapse (once):** stagger-and-fall, becomes the static `corpse` prop below.

**Roster variants** (swap the outfit/silhouette line, keep everything else):
- `Yellow hard-hat + hi-vis vest maintenance worker`
- `Hoodie + backpack urban explorer, camcorder on a strap`
- `Security guard, dark uniform, cap, dead radio on belt`
- `Office worker, untucked dress shirt, loosened tie, lanyard`
- `Night-shift janitor, grey coveralls, ring of keys`
- `Teen in a band tee and jacket, headphones around neck`

### 2b. The Monster — "the thing in the halls"

Matches the reference entity: a tall, wrong, humanoid silhouette that lurks and lunges.
Bigger cell: **64×96 px**, feet at bottom center.

**Walk front (toward camera):**
```
[STYLE BLOCK]
A tall humanoid horror entity for an isometric backrooms game, ¾ front view facing the
camera, angled lower-right. Near-black desaturated navy silhouette #0a0a14, elongated thin
limbs, slightly hunched predatory posture, long arms, no clear face except TWO pale glowing
eyes #cfe8ff (cold white-blue). Faint cold rim light along one edge; body reads as a shadow,
not detailed. Unsettling, smooth-menacing. 64x96 px cell, feet at bottom center.
WALK: 6 frames, a loping stalking gait, subtle limb sway, eyes steady. Horizontal strip.
```
**Walk back:** same, ¾ back view heading away upper-right, eyes not visible (or a faint
back-of-head glow), 6 frames.
**Lurk idle (4f):** standing/swaying menace, slight head tilt, eyes pulsing faint. Used
while roaming/dormant.
> Alt palette if you prefer our earlier look: red eyes `#ff2222`. Reference uses pale eyes.

### 2c. Chaos Agent — the trickster

A corrupted, glitching figure that materializes to sabotage. Cell **48×64 px**.
```
[STYLE BLOCK]
A glitching trickster entity for an isometric backrooms game, ¾ front view, angled
lower-right. Roughly humanoid like a survivor but CORRUPTED: datamosh/VHS-tracking-error
coloring, magenta #d026c9 and cyan #2be2d8 chromatic-aberration split, scanline tearing
across the body, flickering edges, a couple of shifted pixel-block artifacts. Blank dark
eyes. Reads as "a survivor rendered wrong." 48x64 px, feet bottom center.
WALK: 6 frames, slightly jittery/unstable gait. GLITCH-IDLE: 4 frames, standing while the
chromatic split and scanline tear flicker. Horizontal strips, transparent.
```
Back-facing walk: same, ¾ back view upper-right, 6 frames.

---

## 3. PROPS (mostly single-frame; base-anchored)

Author at the target size, base/feet touching the bottom edge, transparent.

| Asset | Key | Size (px) | Prompt seed (after STYLE BLOCK) |
|---|---|---|---|
| Security monitor | `crt` | 40×48 | `A grubby CRT security monitor on a small metal stand, ¾ iso view. Beige-grey plastic, convex glass with faint phosphor-green #35e06a text glow, power LED. Floor-standing. 2ND FRAME: same but screen flickers to static.` |
| Dot-matrix printer | `printer` | 40×36 | `An old beige dot-matrix office printer, ¾ iso view, feed tractor on top, a sheet half-printed sticking up. Dusty. 2ND FRAME: paper advanced further out (printing animation).` |
| Canned-supply cache | `crate` | 44×40 | `A small stash of canned food and supplies for a backrooms survival game — a stack of dented tin cans with faded labels plus a cardboard box, ¾ iso view. Matches the "scattered cans" survival vibe of the reference. Warm grimy tones.` |
| Wooden crate (airdrop) | `crate_wood` | 44×40 | `A weathered wooden supply crate, ¾ iso view, rope handle, stencilled marks worn off, a couple of cans beside it.` |
| Exit sign | `sign` | 28×40 | `A small yellow institutional EXIT sign on a short metal pole/stand, ¾ iso view, black arrow, scuffed. Ominously out of place. Provide a CLEAN version and an ALTERED version (arrow crudely repainted the wrong way, tape over letters) for the chaos agent's fakes.` |
| Printout page | `paper` | 18×22 | `A single sheet of dot-matrix printout lying curled on the floor, ¾ iso view, faint monospace text lines, one torn corner.` |
| Note scrap | `note` | 16×14 | `A small torn scrap of handwritten paper on the floor, ¾ iso, hasty pencil scrawl (illegible), slightly crumpled.` |
| Torn poster | `poster` | 26×32 | `A torn paper poster lying/curled on the floor, ¾ iso, faded institutional notice, water-stained, unreadable.` |
| Corpse | `corpse` | 44×28 | `A slumped dead survivor on the floor for a horror game, ¾ iso top-down, face-down/curled, a dark dried stain spreading beneath. Grim but low-detail, not gory. Matches the survivor character's clothes.` |
| Rubble | `rubble` | 64×32 | `Collapsed ceiling/floor debris filling one isometric diamond floor tile (64x32), ¾ iso — chunks of drywall, dust, bent ceiling grid, a dead fluorescent tube. Impassable pile. Fits flush inside the diamond footprint.` |
| Fluorescent fixture | `lightOn`/`lightOff` | 40×14 | `A long fluorescent ceiling light fixture seen from ¾ iso below, thin white housing. Provide ON (tubes glowing pale white #f5ffe8, subtle bloom kept minimal) and OFF (dead grey tubes) and a 3-frame FLICKER (on / half / off).` |

> `glow` (light bloom) and `spark` (particles) stay procedural — no asset needed.

---

## 4. ENVIRONMENT TILES (optional but high-impact)

### 4a. Carpet floor — key `floor0`,`floor1`,`floor2`
```
[STYLE BLOCK]
A single isometric floor tile, exact 64x32 diamond footprint (fills the diamond, edges meet
cleanly with neighbors), top-down ¾. Damp stained institutional low-pile carpet, sickly
mustard-yellow #b8a44a / #ad9a42, subtle darker moisture stains and speckle, faint seam
lines. Tileable in all directions. Provide 3 subtle variants.
```

### 4b. Walls — recommended approach

The wall pieces are **thin planes on tile edges** with an exact skewed geometry
(`WALL_TEX` = 32 wide × 52 tall, in two orientations H/V). Perfectly matching that skew from
an image model is fiddly. **Recommended:** don't generate the wall *pieces* — generate a
flat, tileable **wallpaper + baseboard strip** and I'll map it onto the existing procedural
wall geometry (keeps perfect alignment, gains real texture):
```
[STYLE BLOCK]
A seamless tileable wall texture strip for a backrooms game: aged institutional wallpaper,
uniform mustard-olive #9c8f45, faint vertical striping, water stains and scuffs, a darker
baseboard band #574d26 along the bottom. Flat front-on view, evenly lit, seamless left-right.
```
If you'd rather generate the actual angled pieces, I can export exact silhouette masks for
`wallH`, `wallV`, `doorH/V`, `doorLockedH/V` to trace against — ask and I'll produce them.

---

## 5. Delivery checklist

- Transparent PNG, 1× pixel scale, nearest-neighbor, no AA/blur, no baked shadow/light/text.
- Characters: `walk_front`, `walk_back`, `idle_front`, `idle_back` horizontal strips, fixed
  cell (48×64 survivor/chaos, 64×96 monster), consistent feet baseline.
- Props/tiles: single frame (or the noted 2–3 frame strips), base at bottom edge.
- Name files to the `key` column so wiring is mechanical.
- Send me the frame counts per animation → I add the Phaser loader + `anim` definitions and
  swap each procedural placeholder for the real texture, one key at a time.
```
