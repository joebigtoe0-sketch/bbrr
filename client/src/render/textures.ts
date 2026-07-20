import Phaser from 'phaser';
import { TILE_W, TILE_H, WALL_H, WALL_TEX_W, WALL_TEX_H } from './iso.js';

/**
 * Build the wall/door plane textures from the generated wallpaper strip by
 * shearing it onto the edge-plane parallelogram. Runs BEFORE generateTextures;
 * if the wallpaper image isn't loaded, the procedural planes take over.
 *
 * Wall-space transform: canvasY = y0 + slope*x + (u - WALL_H), where u runs
 * 0 (wall top) .. WALL_H (ground). H edges rise to the right (slope +0.5),
 * V edges fall (slope -0.5).
 */
export function generateWallTexturesFromWallpaper(scene: Phaser.Scene) {
  if (!scene.textures.exists('wallpaperStrip')) return;
  const src = scene.textures.get('wallpaperStrip').getSourceImage() as HTMLImageElement;
  const W = WALL_TEX_W;
  const H = WALL_TEX_H;

  const make = (key: string, dir: 'h' | 'v', style: 'wall' | 'doorway' | 'locked') => {
    const tex = scene.textures.createCanvas(key, W, H);
    if (!tex) return;
    const ctx = tex.getContext();
    const slope = dir === 'h' ? 0.5 : -0.5;
    const y0 = dir === 'h' ? H - 16 : H;
    ctx.setTransform(1, slope, 0, 1, 0, y0 - WALL_H);

    // wallpaper (its baked-in baseboard band lands at the wall bottom)
    ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, W, WALL_H);
    // orientation shading: V faces darker, H faces a touch warmer
    ctx.fillStyle = dir === 'h' ? 'rgba(255,240,200,0.06)' : 'rgba(0,0,25,0.22)';
    ctx.fillRect(0, 0, W, WALL_H);
    // top lip
    ctx.fillStyle = '#d8cb74';
    ctx.fillRect(0, -2, W, 2);

    if (style === 'doorway') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillRect(0.2 * W, 8, 0.6 * W, WALL_H - 8); // see-through opening
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#3a3216';
      ctx.fillRect(0.2 * W, 8, 1.5, WALL_H - 8);
      ctx.fillRect(0.8 * W - 1.5, 8, 1.5, WALL_H - 8);
      ctx.fillRect(0.2 * W, 8, 0.6 * W, 1.5); // lintel underline
    } else if (style === 'locked') {
      if (scene.textures.exists('doorLeaf')) {
        // generated sealed-door art, cropped past its baked-in wall margin
        const leaf = scene.textures.get('doorLeaf').getSourceImage() as HTMLImageElement;
        ctx.drawImage(
          leaf,
          leaf.width * 0.08,
          leaf.height * 0.02,
          leaf.width * 0.84,
          leaf.height * 0.96,
          0.12 * W,
          5,
          0.76 * W,
          WALL_H - 5,
        );
      } else {
        ctx.fillStyle = '#241a0e';
        ctx.fillRect(0.14 * W, 6, 0.72 * W, WALL_H - 6);
        ctx.fillStyle = '#b3312e';
        ctx.fillRect(0.2 * W, WALL_H / 2 - 2, 0.6 * W, 4);
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    tex.refresh();
  };

  make('wallH', 'h', 'wall');
  make('wallV', 'v', 'wall');
  make('doorH', 'h', 'doorway');
  make('doorV', 'v', 'doorway');
  make('doorLockedH', 'h', 'locked');
  make('doorLockedV', 'v', 'locked');
}

/**
 * All placeholder art is generated here with Graphics — no external assets.
 * Backrooms palette: dirty yellows, damp carpet, fluorescent white-green.
 */
export function generateTextures(scene: Phaser.Scene) {
  const g = scene.add.graphics();

  // only generate a placeholder if a real asset wasn't already loaded for this key
  const gen = (key: string, w: number, h: number) => {
    if (!scene.textures.exists(key)) g.generateTexture(key, w, h);
  };

  const diamond = (
    gg: Phaser.GameObjects.Graphics,
    cx: number,
    cy: number,
    color: number,
    alpha = 1,
  ) => {
    gg.fillStyle(color, alpha);
    gg.beginPath();
    gg.moveTo(cx, cy - TILE_H / 2);
    gg.lineTo(cx + TILE_W / 2, cy);
    gg.lineTo(cx, cy + TILE_H / 2);
    gg.lineTo(cx - TILE_W / 2, cy);
    gg.closePath();
    gg.fillPath();
  };

  // ---- floor variants (stippled damp carpet) ----
  for (const [key, base, stipple] of [
    ['floor0', 0xb8a44a, 0x9c8a3c],
    ['floor1', 0xad9a42, 0x93822f],
  ] as const) {
    g.clear();
    diamond(g, TILE_W / 2, TILE_H / 2, base);
    g.lineStyle(1, 0x8a7a35, 0.6);
    g.beginPath();
    g.moveTo(TILE_W / 2, 0);
    g.lineTo(TILE_W, TILE_H / 2);
    g.lineTo(TILE_W / 2, TILE_H);
    g.lineTo(0, TILE_H / 2);
    g.closePath();
    g.strokePath();
    g.fillStyle(stipple, 0.7);
    for (let i = 0; i < 14; i++) {
      const t = Math.random();
      const u = Math.random();
      // random point inside the diamond via barycentric-ish sampling
      const px = TILE_W / 2 + (t - u) * (TILE_W / 2 - 4);
      const py = TILE_H / 2 + (t + u - 1) * (TILE_H / 2 - 3);
      g.fillRect(px, py, 2, 1);
    }
    gen(key, TILE_W, TILE_H);
  }

  // ---- edge walls: thin planes standing ON the border between two tiles ----
  // H edge (a tile's north border) spans from its N corner to its E corner;
  // V edge (west border) spans from its W corner to its N corner.
  // Canvas: 32 wide, 16px of edge drop + WALL_H of face + 2px top lip.
  const edgeTex = (key: string, dir: 'h' | 'v', face: number, style: 'wall' | 'doorway' | 'locked') => {
    g.clear();
    const H = WALL_TEX_H;
    const gl = dir === 'h' ? { x0: 0, y0: H - 16, x1: 32, y1: H } : { x0: 0, y0: H, x1: 32, y1: H - 16 };
    // fill a sub-quad of the wall plane: f = fraction along the edge, h = px above ground
    const sub = (f0: number, f1: number, h0: number, h1: number, color: number, alpha = 1) => {
      const ax = gl.x0 + (gl.x1 - gl.x0) * f0;
      const ay = gl.y0 + (gl.y1 - gl.y0) * f0;
      const bx = gl.x0 + (gl.x1 - gl.x0) * f1;
      const by = gl.y0 + (gl.y1 - gl.y0) * f1;
      g.fillStyle(color, alpha);
      g.beginPath();
      g.moveTo(ax, ay - h0);
      g.lineTo(bx, by - h0);
      g.lineTo(bx, by - h1);
      g.lineTo(ax, ay - h1);
      g.closePath();
      g.fillPath();
    };
    const lip = 0xd8cb74;
    if (style === 'wall') {
      sub(0, 1, 0, WALL_H, face);
      sub(0, 1, WALL_H / 3, WALL_H / 3 + 1.5, 0x000000, 0.07);
      sub(0, 1, (2 * WALL_H) / 3, (2 * WALL_H) / 3 + 1.5, 0x000000, 0.07);
      sub(0, 1, 0, 5, 0x574d26); // baseboard
      sub(0, 1, WALL_H, WALL_H + 2, lip);
    } else if (style === 'doorway') {
      // open doorway: two jambs + a lintel, see-through in the middle
      sub(0, 0.2, 0, WALL_H, face);
      sub(0.8, 1, 0, WALL_H, face);
      sub(0, 0.2, 0, 5, 0x574d26);
      sub(0.8, 1, 0, 5, 0x574d26);
      sub(0.2, 0.8, WALL_H - 8, WALL_H, face); // lintel
      sub(0.18, 0.22, 0, WALL_H - 8, 0x3a3216); // frame shadow
      sub(0.78, 0.82, 0, WALL_H - 8, 0x3a3216);
      sub(0.2, 0.8, WALL_H - 9, WALL_H - 8, 0x3a3216);
      sub(0, 1, WALL_H, WALL_H + 2, lip);
    } else {
      // locked: a closed dark door leaf filling the frame, red seal
      sub(0, 1, 0, WALL_H, face);
      sub(0.14, 0.86, 0, WALL_H - 6, 0x241a0e);
      sub(0.2, 0.8, WALL_H / 2 - 2, WALL_H / 2 + 2, 0xb3312e);
      sub(0, 1, 0, 4, 0x574d26);
      sub(0, 1, WALL_H, WALL_H + 2, lip);
    }
    gen(key, WALL_TEX_W, WALL_TEX_H);
  };
  // V edges run up-left (darker shade), H edges up-right (lighter shade)
  edgeTex('wallH', 'h', 0x9c8f45, 'wall');
  edgeTex('wallV', 'v', 0x877b39, 'wall');
  edgeTex('doorH', 'h', 0x9c8f45, 'doorway');
  edgeTex('doorV', 'v', 0x877b39, 'doorway');
  edgeTex('doorLockedH', 'h', 0x8a7d3e, 'locked');
  edgeTex('doorLockedV', 'v', 0x776b34, 'locked');

  // ---- rubble (flat) ----
  g.clear();
  diamond(g, TILE_W / 2, TILE_H / 2, 0x4a4436);
  g.fillStyle(0x6b6350, 1);
  g.fillCircle(24, 14, 5);
  g.fillCircle(38, 18, 6);
  g.fillCircle(30, 22, 4);
  g.fillStyle(0x7d7560, 1);
  g.fillCircle(33, 13, 3);
  gen('rubble', TILE_W, TILE_H);

  // ---- fluorescent light bar (drawn hanging; anchored center) ----
  g.clear();
  g.fillStyle(0x2a2a2a, 1);
  g.fillRect(2, 0, 28, 4);
  g.fillStyle(0xf5ffe8, 1);
  g.fillRect(0, 4, 32, 6);
  gen('lightOn', 32, 10);
  g.clear();
  g.fillStyle(0x2a2a2a, 1);
  g.fillRect(2, 0, 28, 4);
  g.fillStyle(0x3a3f38, 1);
  g.fillRect(0, 4, 32, 6);
  gen('lightOff', 32, 10);

  // glow (concentric circles fake a radial gradient)
  g.clear();
  for (let r = 40; r > 0; r -= 4) {
    g.fillStyle(0xfff8d0, 0.028);
    g.fillCircle(40, 40, r);
  }
  gen('glow', 80, 80);

  // ---- CRT terminal ----
  g.clear();
  g.fillStyle(0x2e2e30, 1);
  g.fillRect(0, 4, 26, 22);
  g.fillStyle(0x3c3c40, 1);
  g.fillRect(0, 0, 26, 6);
  g.fillStyle(0x07230e, 1);
  g.fillRect(3, 8, 20, 13);
  g.fillStyle(0x35e06a, 0.9);
  g.fillRect(5, 11, 12, 2);
  g.fillRect(5, 15, 8, 2);
  gen('crt', 26, 28);

  // ---- printer ----
  g.clear();
  g.fillStyle(0x8b8b85, 1);
  g.fillRect(0, 6, 26, 14);
  g.fillStyle(0x6e6e68, 1);
  g.fillRect(2, 2, 22, 6);
  g.fillStyle(0xf2f2e6, 1);
  g.fillRect(6, 0, 14, 4);
  gen('printer', 26, 20);

  // ---- paper / printout ----
  g.clear();
  g.fillStyle(0xf2f2e6, 1);
  g.fillRect(1, 0, 12, 14);
  g.lineStyle(1, 0x9a9a8a, 1);
  g.strokeRect(1, 0, 12, 14);
  g.lineStyle(1, 0x777768, 0.9);
  for (let i = 3; i < 12; i += 3) g.strokeLineShape(new Phaser.Geom.Line(3, i, 11, i));
  gen('paper', 14, 15);

  // ---- crate ----
  g.clear();
  g.fillStyle(0x7a5c33, 1);
  g.fillRect(0, 6, 28, 18);
  g.fillStyle(0x91713f, 1);
  g.fillRect(0, 0, 28, 8);
  g.lineStyle(2, 0x4f3a1c, 1);
  g.strokeRect(1, 1, 26, 22);
  g.strokeLineShape(new Phaser.Geom.Line(14, 0, 14, 24));
  gen('crate', 28, 24);

  // ---- sign ----
  g.clear();
  g.fillStyle(0x3a3a3a, 1);
  g.fillRect(9, 12, 4, 14);
  g.fillStyle(0xd8cf6e, 1);
  g.fillRect(0, 0, 22, 14);
  g.lineStyle(1, 0x2a2a1a, 1);
  g.strokeRect(0, 0, 22, 14);
  gen('sign', 22, 26);

  // ---- note (scrap of paper on floor) ----
  g.clear();
  g.fillStyle(0xe8e4c8, 1);
  g.beginPath();
  g.moveTo(2, 1);
  g.lineTo(12, 0);
  g.lineTo(13, 9);
  g.lineTo(1, 10);
  g.closePath();
  g.fillPath();
  gen('note', 14, 11);

  // ---- corpse (stain + slumped shape) ----
  g.clear();
  g.fillStyle(0x3d0f10, 0.85);
  g.fillEllipse(16, 10, 30, 14);
  g.fillStyle(0x1e1a12, 1);
  g.fillEllipse(14, 8, 16, 7);
  g.fillCircle(23, 7, 4);
  gen('corpse', 34, 20);

  // ---- agent capsule (white; tinted per agent) ----
  g.clear();
  g.fillStyle(0xffffff, 1);
  g.fillRoundedRect(2, 6, 14, 26, 7);
  g.fillCircle(9, 7, 6);
  g.fillStyle(0x222222, 1);
  g.fillRect(6, 5, 2, 2);
  g.fillRect(11, 5, 2, 2);
  gen('agent', 18, 34);

  // ---- monster ----
  g.clear();
  g.fillStyle(0x0a0a0c, 1);
  g.fillEllipse(22, 60, 30, 40);
  g.fillEllipse(22, 30, 22, 45);
  g.fillEllipse(22, 12, 16, 18);
  // ragged edges
  g.fillTriangle(6, 40, 0, 64, 14, 56);
  g.fillTriangle(38, 44, 44, 70, 30, 58);
  g.fillStyle(0xff2222, 1);
  g.fillCircle(18, 10, 2);
  g.fillStyle(0x8b0000, 0.8);
  g.fillCircle(27, 12, 1.5);
  gen('monster', 44, 84);

  // ---- chaos agent (glitchy silhouette) ----
  g.clear();
  g.fillStyle(0xd026c9, 0.9);
  g.fillRoundedRect(4, 8, 14, 34, 6);
  g.fillCircle(11, 8, 7);
  g.fillStyle(0x2be2d8, 0.8);
  g.fillRect(0, 14, 22, 2);
  g.fillRect(0, 26, 22, 2);
  g.fillStyle(0x0a0a0a, 1);
  g.fillRect(7, 5, 3, 3);
  g.fillRect(13, 5, 3, 3);
  gen('chaos', 24, 46);

  // ---- particle spark ----
  g.clear();
  g.fillStyle(0xffd75e, 1);
  g.fillRect(0, 0, 3, 3);
  gen('spark', 3, 3);

  g.destroy();
}
