// Prompt manifest for scripts/gen-assets.mjs.
// The runner prepends STYLE_BLOCK to each `prompt`, so keep prompts subject-only.
// `file` is the output filename; `key` lets you regen one asset:
//   node scripts/gen-assets.mjs crt printer
// Sizes gpt-image-1 accepts: 1024x1024, 1024x1536 (portrait), 1536x1024 (landscape).

export const STYLE_BLOCK = `Retro pixel-art game sprite, 2D found-footage horror, isometric 2:1 dimetric three-quarter view. Chunky low-resolution pixels, crisp hard edges, no anti-aliasing, no blur, limited palette. Sickly institutional "backrooms" mood but the sprite itself is neutral/flat-lit. Transparent background, single subject centered, full body, feet at the bottom edge, no ground shadow, no scenery, no text, no scanlines, no UI, no border. Palette: dirty fluorescent yellows #b8a44a #ad9a42, olive walls #9c8f45 #877b39, cold shadows, pale fluorescent white #f5ffe8. VHS-era 90s survival-horror vibe.`;

export const ASSETS = [
  // ---- props (single frame, transparent) ----
  {
    key: 'crt',
    file: 'crt.png',
    size: '1024x1024',
    prompt:
      'A grubby CRT security monitor on a small metal floor stand, three-quarter iso view. Beige-grey plastic, convex glass with faint phosphor-green (#35e06a) text glow and a power LED. Dusty, worn.',
  },
  {
    key: 'printer',
    file: 'printer.png',
    size: '1024x1024',
    prompt:
      'An old beige dot-matrix office printer, three-quarter iso view, tractor feed on top, a sheet of paper half-printed sticking up out of it. Dusty, worn plastic.',
  },
  {
    key: 'crate',
    file: 'cans.png',
    size: '1024x1024',
    prompt:
      'A small survival supply cache: a stack of dented tin food cans with faded peeling labels beside a battered cardboard box, three-quarter iso view. Grimy warm tones. Matches a scavenged-supplies horror vibe.',
  },
  {
    key: 'crate_wood',
    file: 'crate_wood.png',
    size: '1024x1024',
    prompt:
      'A weathered wooden supply crate, three-quarter iso view, rope handle on the side, faded worn stencil marks, a couple of tin cans resting beside it.',
  },
  {
    key: 'sign',
    file: 'sign_exit.png',
    size: '1024x1024',
    prompt:
      'A small yellow institutional EXIT sign on a short metal floor stand, three-quarter iso view, bold black directional arrow, scuffed and slightly bent. Ominously out of place.',
  },
  {
    key: 'sign_fake',
    file: 'sign_exit_fake.png',
    size: '1024x1024',
    prompt:
      'A tampered yellow EXIT sign on a short metal stand, three-quarter iso view: the arrow crudely repainted pointing the wrong way, strips of tape stuck over some letters, a hostile scrawl. Unsettling.',
  },
  {
    key: 'corpse',
    file: 'corpse.png',
    size: '1024x1024',
    prompt:
      'A slumped dead survivor lying on the floor for a horror game, three-quarter top-down iso view, curled/face-down, a dark dried stain spreading beneath. Grim but low-detail, not gory. Navy shirt, brown trousers.',
  },
  {
    key: 'rubble',
    file: 'rubble.png',
    size: '1024x1024',
    prompt:
      'A pile of collapsed ceiling and floor debris — broken drywall chunks, dust, a bent ceiling grid, a shattered fluorescent tube — three-quarter iso view, sitting as one compact impassable heap.',
  },
  {
    key: 'lightOn',
    file: 'light_on.png',
    size: '1536x1024',
    prompt:
      'A long fluorescent ceiling light fixture viewed from three-quarter iso below, thin white metal housing, two tubes glowing pale white (#f5ffe8) with only a subtle bloom. Institutional.',
  },
  {
    key: 'lightOff',
    file: 'light_off.png',
    size: '1536x1024',
    prompt:
      'A long dead fluorescent ceiling light fixture viewed from three-quarter iso below, thin white metal housing, two dark grey unlit tubes. Institutional, lifeless.',
  },

  // ---- environment tiles ----
  {
    key: 'floor',
    file: 'floor_carpet.png',
    size: '1024x1024',
    prompt:
      'A single isometric floor tile filling a 2:1 diamond footprint, top-down three-quarter view. Damp stained institutional low-pile carpet, sickly mustard-yellow (#b8a44a / #ad9a42), subtle darker moisture stains and speckle, faint seam lines. Edges meet cleanly for tiling.',
  },
  {
    key: 'wallpaper',
    file: 'wallpaper_strip.png',
    size: '1024x1024',
    prompt:
      'A seamless tileable wall texture, flat front-on view, evenly lit: aged institutional wallpaper in uniform mustard-olive (#9c8f45), faint vertical striping, water stains and scuffs, a darker baseboard band (#574d26) along the bottom edge. Seamless left-to-right.',
  },

  // ---- character concept frames (portrait) ----
  // gpt-image-1 makes strong single poses, NOT clean walk sheets. Use these as
  // reference/idle frames or hand off to a sprite tool for the walk cycles.
  {
    key: 'survivor_front',
    file: 'survivor_idle_front.png',
    size: '1024x1536',
    prompt:
      'A lone survivor character for an isometric backrooms horror game, three-quarter FRONT view facing the camera, angled toward the lower-right, standing idle. Ordinary young adult, short practical hair, navy-blue short-sleeve shirt (#3b5b8c), brown work trousers (#6b4a2f), worn sneakers, holding a small handheld flashlight (beam not drawn). Slightly hunched, nervous, tired. Full body, feet at bottom.',
  },
  {
    key: 'survivor_back',
    file: 'survivor_idle_back.png',
    size: '1024x1536',
    prompt:
      "A lone survivor character for an isometric backrooms horror game, three-quarter BACK view — we see their back and the back of their head — angled toward the upper-right, walking away, holding a flashlight forward (away from us). Navy short-sleeve shirt, brown trousers, worn sneakers. Full body, feet at bottom.",
  },
  {
    key: 'monster',
    file: 'monster_front.png',
    size: '1024x1536',
    prompt:
      'A tall humanoid horror entity for an isometric backrooms game, three-quarter FRONT view facing the camera, angled lower-right. Near-black desaturated navy silhouette (#0a0a14), elongated thin limbs, hunched predatory posture, long arms, no face except two pale glowing cold white-blue eyes (#cfe8ff), a faint cold rim light on one edge. Reads as a living shadow. Full body, feet at bottom.',
  },
  {
    key: 'chaos',
    file: 'chaos_front.png',
    size: '1024x1536',
    prompt:
      'A glitching trickster entity for an isometric backrooms game, three-quarter FRONT view, angled lower-right. Roughly humanoid like a survivor but corrupted: datamosh / VHS tracking-error coloring, magenta (#d026c9) and cyan (#2be2d8) chromatic-aberration split, scanline tearing across the body, flickering edges, a few shifted pixel-block artifacts, blank dark eyes. Reads as "a survivor rendered wrong." Full body, feet at bottom.',
  },
];
