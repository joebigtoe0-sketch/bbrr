import Phaser from 'phaser';
import { CHUNK_SIZE, EDGE, TILE, chunkKey, tileToChunk } from '@backrooms/shared';
import type { Agent, EvidenceArtifact, MazeChunk, ThoughtEvent, WorldEvent } from '@backrooms/shared';
import { WorldStore } from '../state/worldStore.js';
import { Connection } from '../net/connection.js';
import {
  FLOOR_DEPTH,
  WALL_H,
  depthOf,
  entityToScreen,
  gridToScreen,
  screenToGrid,
} from '../render/iso.js';
import {
  initReader,
  initSpawnModal,
  openReader,
  playTuneIn,
  refreshDeaths,
  renderAgentList,
  toast,
} from '../ui/dom.js';

interface ChunkView {
  rt: Phaser.GameObjects.RenderTexture;
  sprites: Phaser.GameObjects.GameObject[];
  /** tile keys ("gx,gy") of wall/door sprites registered in wallIndex */
  wallKeys: string[];
  version: number;
}

interface AgentView {
  sprite: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text;
  gx: number;
  gy: number;
  /**
   * Queue of server positions still to be walked through. Following the
   * actual 10 Hz sample trail (instead of easing straight toward the latest
   * position) keeps sprites inside corridors — no cutting corners through
   * wall planes.
   */
  queue: { x: number; y: number }[];
  /** smoothed flashlight beam angle (radians, screen space) */
  beamAngle: number;
}

/** a text drifting upward until it leaves the top of the screen */
interface Floater {
  obj: Phaser.GameObjects.Text;
  vy: number; // world px/s upward
  born: number;
}

const FLOATER_DEPTH = 5_000_000;
const DARKNESS_DEPTH = 1_000_000;
const BLIP_DEPTH = 1_100_000;

/** screen-space beam angles for the four facings (iso axes) */
const FACING_ANGLE: Record<string, number> = {
  e: Math.atan2(16, 32),
  s: Math.atan2(16, -32),
  n: Math.atan2(-16, 32),
  w: Math.atan2(-16, -32),
};

/**
 * On-screen height (world px, pre-zoom) for real loaded art. The generated PNGs
 * are large, so we scale each to sprite size preserving aspect. Keys not listed
 * are procedural placeholders already at native size.
 */
const ART_HEIGHT: Record<string, number> = {
  crt: 34,
  printer: 28,
  crate: 32,
  sign: 40,
  corpse: 26,
  rubble: 30,
  lightOn: 16,
  lightOff: 16,
  note: 14,
};

function scaleArt(img: Phaser.GameObjects.Image): Phaser.GameObjects.Image {
  const h = ART_HEIGHT[img.texture.key];
  if (h && img.height > 0) img.setScale(h / img.height);
  return img;
}

export class WorldScene extends Phaser.Scene {
  private store = new WorldStore();
  private conn = new Connection(this.store);
  private chunkViews = new Map<string, ChunkView>();
  private evidenceViews = new Map<string, Phaser.GameObjects.GameObject[]>();
  private agentViews = new Map<string, AgentView>();
  private monsterView!: Phaser.GameObjects.Image;
  private chaosView!: Phaser.GameObjects.Image;
  private tunedAgentId: string | null = null;
  private followAgentId: string | null = null;
  private wallIndex = new Map<string, Phaser.GameObjects.Image[]>();
  private fadedWalls = new Set<string>();
  private floaters: Floater[] = [];
  private monsterTrail = { gx: 0, gy: 0, queue: [] as { x: number; y: number }[] };
  private darkRT!: Phaser.GameObjects.RenderTexture;
  private eraserCone!: Phaser.GameObjects.Image;
  private eraserPool!: Phaser.GameObjects.Image;
  private eraserChunk!: Phaser.GameObjects.Image;
  private monsterEyes!: Phaser.GameObjects.Image;
  /** per-chunk powered-light intensity, tweened on power events */
  private power = new Map<string, { v: number }>();
  /** wall keys to keep translucent because evidence sits right behind them */
  private evidenceFadeKeys = new Set<string>();
  private evidenceFadeDirty = true;
  private subTimer = 0;
  private sidebarTimer = 0;
  private sidebarDirty = true;
  private lastSubSignature = '';
  private centeredOnce = false;
  private dragDist = 0;

  constructor() {
    super('world');
  }

  create() {
    this.cameras.main.setBackgroundColor('#050503');
    this.cameras.main.setZoom(1.8);

    // the darkness: a screen-space veil that light sources erase holes into
    this.darkRT = this.add
      .renderTexture(0, 0, this.scale.width, this.scale.height)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(DARKNESS_DEPTH);
    this.scale.on('resize', (s: Phaser.Structs.Size) => this.darkRT.resize(s.width, s.height));
    this.eraserCone = this.add.image(0, 0, 'flashCone').setOrigin(0.02, 0.5).setVisible(false);
    this.eraserPool = this.add.image(0, 0, 'flashPool').setOrigin(0.5).setVisible(false);
    this.eraserChunk = this.add.image(0, 0, 'chunkLight').setOrigin(0.5).setVisible(false);
    this.monsterEyes = this.add.image(0, 0, 'eyes').setDepth(BLIP_DEPTH).setVisible(false);

    this.monsterView = this.add
      .image(0, 0, 'monster')
      .setOrigin(0.5, 1)
      .setDepth(0)
      .setVisible(false);
    this.chaosView = this.add
      .image(0, 0, 'chaos')
      .setOrigin(0.5, 1)
      .setDepth(0)
      .setVisible(false);

    this.wireStore();
    this.wireInput();
    this.wireUi();
    this.conn.onOpen = () => {
      this.lastSubSignature = ''; // resend subscriptions after reconnect
    };
    this.conn.connect();

    this.time.addEvent({ delay: 30000, loop: true, callback: () => refreshDeaths() });
    refreshDeaths();
  }

  // ---------------- store wiring ----------------

  private wireStore() {
    const s = this.store;
    s.onSnapshot = () => {
      for (const v of this.agentViews.values()) {
        v.sprite.destroy();
        v.label.destroy();
      }
      this.agentViews.clear();
      for (const a of s.agents.values()) this.upsertAgent(a);
      this.updateMonster();
      this.updateChaos();
      this.sidebarDirty = true;
      if (!this.centeredOnce) {
        this.centeredOnce = true;
        const first = [...s.agents.values()][0];
        const p = gridToScreen(first ? first.x : 8, first ? first.y : 8);
        this.cameras.main.centerOn(p.sx, p.sy);
      }
    };
    s.onChunk = (c) => this.buildChunkView(c);
    s.onChunkChanged = (key) => {
      const c = s.chunks.get(key);
      if (c) this.buildChunkView(c);
    };
    s.onAgent = (a) => {
      this.upsertAgent(a);
      this.sidebarDirty = true;
    };
    s.onAgentRemove = (id) => {
      const v = this.agentViews.get(id);
      if (v) {
        v.sprite.destroy();
        v.label.destroy();
        this.agentViews.delete(id);
      }
      if (this.tunedAgentId === id) this.tunedAgentId = null;
      if (this.followAgentId === id) this.followAgentId = null;
      this.sidebarDirty = true;
    };
    s.onMonster = () => this.updateMonster();
    s.onChaos = () => this.updateChaos();
    s.onEvidence = (e, isNew) => {
      this.upsertEvidence(e, isNew);
      this.evidenceFadeDirty = true;
    };
    s.onEvidenceRemove = (id) => {
      for (const o of this.evidenceViews.get(id) ?? []) o.destroy();
      this.evidenceViews.delete(id);
      this.evidenceFadeDirty = true;
    };
    s.onLight = (cx, cy, on) => this.onLightChange(cx, cy, on);
    s.onWorldEvent = (e) => this.handleWorldEvent(e);
    s.onSpeech = (agentId, text) => this.showSpeech(agentId, text);
    s.onThought = (t) => this.showThought(t);
  }

  // ---------------- chunk rendering ----------------

  private powerOf(key: string, lightsOn: boolean): { v: number } {
    let rec = this.power.get(key);
    if (!rec) {
      rec = { v: lightsOn ? 1 : 0 };
      this.power.set(key, rec);
    }
    return rec;
  }

  private onLightChange(cx: number, cy: number, on: boolean) {
    const key = chunkKey(cx, cy);
    const rec = this.powerOf(key, !on); // ensure record exists at previous state
    this.tweens.add({ targets: rec, v: on ? 1 : 0, duration: 900, ease: 'Sine.easeInOut' });
    const c = this.store.chunks.get(key);
    if (c) this.buildChunkView(c); // swap fixture bar textures + glows
  }

  private buildChunkView(c: MazeChunk) {
    const key = chunkKey(c.cx, c.cy);
    const old = this.chunkViews.get(key);
    if (old) {
      old.rt.destroy();
      for (const sp of old.sprites) sp.destroy();
      for (const wk of old.wallKeys) this.wallIndex.delete(wk);
      this.chunkViews.delete(key);
    }

    const S = CHUNK_SIZE;
    const origin = { gx: c.cx * S, gy: c.cy * S };
    // RT bounds: leftmost diamond is (0, S-1), topmost is (0,0)
    const left = gridToScreen(origin.gx, origin.gy + S - 1);
    const top = gridToScreen(origin.gx, origin.gy);
    const rtX = left.sx - 32;
    const rtY = top.sy - 16;
    const rtW = S * 64;
    const rtH = (2 * S - 1) * 16 + 32;

    const rt = this.add.renderTexture(rtX, rtY, rtW, rtH).setOrigin(0, 0).setDepth(FLOOR_DEPTH);
    this.powerOf(key, c.lightsOn);
    const sprites: Phaser.GameObjects.GameObject[] = [];
    const wallKeys: string[] = [];

    for (let ly = 0; ly < S; ly++) {
      for (let lx = 0; lx < S; lx++) {
        const i = ly * S + lx;
        const t = c.tiles[i]!;
        if (t === TILE.Void) continue;
        const gx = origin.gx + lx;
        const gy = origin.gy + ly;
        const p = gridToScreen(gx, gy);

        // carpet everywhere — the darkness overlay owns all lighting now
        const floorKey = (gx + gy) % 2 === 0 ? 'floor0' : 'floor1';
        rt.draw(floorKey, p.sx - rtX - 32, p.sy - rtY - 16);
        if (t === TILE.Rubble) {
          const img = scaleArt(
            this.add
              .image(p.sx, p.sy, 'rubble')
              .setOrigin(0.5, 0.6)
              .setDepth(depthOf(gx + 0.5, gy + 0.5, -4)),
          );
          sprites.push(img);
        }

        // edge walls: H = north border (N->E corner), V = west border (W->N)
        const eh = c.wallsH[i]!;
        if (eh !== EDGE.None) {
          const tex = eh === EDGE.Wall ? 'wallH' : eh === EDGE.DoorOpen ? 'doorH' : 'doorLockedH';
          const img = this.add
            .image(p.sx, p.sy, tex)
            .setOrigin(0, 1)
            .setDepth(depthOf(gx + 0.5, gy, 0));
          sprites.push(img);
          const wk = `h:${gx},${gy}`;
          this.wallIndex.set(wk, [img]);
          wallKeys.push(wk);
        }
        const ev = c.wallsV[i]!;
        if (ev !== EDGE.None) {
          const tex = ev === EDGE.Wall ? 'wallV' : ev === EDGE.DoorOpen ? 'doorV' : 'doorLockedV';
          const img = this.add
            .image(p.sx, p.sy, tex)
            .setOrigin(1, 1)
            .setDepth(depthOf(gx, gy + 0.5, 0));
          sprites.push(img);
          const wk = `v:${gx},${gy}`;
          this.wallIndex.set(wk, [img]);
          wallKeys.push(wk);
        }

        // fluorescent fixtures, sparser for a moodier found-footage look
        // (proper modulo: JS % is negative for negative coords, which used to
        // erase every fixture west/north of the origin)
        if (t === TILE.Floor && (((gx % 6) + 6) % 6) === 2 && (((gy % 6) + 6) % 6) === 3) {
          const bar = scaleArt(
            this.add
              .image(p.sx, p.sy - WALL_H - 10, c.lightsOn ? 'lightOn' : 'lightOff')
              .setDepth(depthOf(gx + 0.5, gy + 0.5, 20))
              // both states share one image; a cold dark tint sells "dead tubes"
              .setTint(c.lightsOn ? 0xffffff : 0x3f4450),
          );
          sprites.push(bar);
          if (c.lightsOn) {
            const glow = this.add
              .image(p.sx, p.sy, 'glow')
              .setBlendMode(Phaser.BlendModes.ADD)
              .setScale(2.2, 1.4)
              .setAlpha(0.8)
              .setDepth(depthOf(gx + 0.5, gy + 0.5, -6));
            sprites.push(glow);
          }
        }
      }
    }
    this.chunkViews.set(key, { rt, sprites, wallKeys, version: c.version });
  }

  // ---------------- evidence rendering ----------------

  private upsertEvidence(e: EvidenceArtifact, isNew: boolean) {
    for (const o of this.evidenceViews.get(e.id) ?? []) o.destroy();
    const p = entityToScreen(e.x + 0.5, e.y + 0.5);
    const eDepth = (bias = 0) => depthOf(e.x + 0.5, e.y + 0.5, bias);
    const objs: Phaser.GameObjects.GameObject[] = [];
    const interactive = (obj: Phaser.GameObjects.Image | Phaser.GameObjects.Text, handler: () => void) => {
      obj.setInteractive({ useHandCursor: true });
      obj.on('pointerup', (pointer: Phaser.Input.Pointer) => {
        if (pointer.getDistance() < 8) handler();
      });
    };

    switch (e.kind) {
      case 'graffiti': {
        const img = this.makeGraffiti(e);
        img.setDepth(eDepth(-3));
        interactive(img, () =>
          openReader('GRAFFITI', [
            `"${e.text ?? ''}"`,
            e.authorName ? `— scratched by ${e.authorName}` : '— author unknown',
          ]),
        );
        objs.push(img);
        break;
      }
      case 'crt': {
        const img = scaleArt(
          this.add.image(p.sx, p.sy + 6, 'crt').setOrigin(0.5, 1).setDepth(eDepth()),
        );
        // tiny LED that blinks through the darkness so watchers can find it
        const led = this.add
          .image(p.sx + 5, p.sy - 20, 'blip')
          .setDepth(BLIP_DEPTH)
          .setAlpha(0.2);
        this.tweens.add({
          targets: led,
          alpha: 1,
          duration: 650,
          yoyo: true,
          repeat: -1,
          delay: Math.random() * 1200,
          hold: 120,
        });
        objs.push(led);
        interactive(img, () => {
          const lines = (e.meta?.lines as string[] | undefined) ?? [];
          openReader(
            'TERMINAL // internal log',
            lines.length > 0 ? lines : ['[no entries yet — the cursor blinks]'],
          );
        });
        objs.push(img);
        break;
      }
      case 'printer': {
        const img = scaleArt(
          this.add.image(p.sx, p.sy + 4, 'printer').setOrigin(0.5, 1).setDepth(eDepth()),
        );
        interactive(img, () => openReader('PRINTER', ['An old printer. It hums, waiting.']));
        objs.push(img);
        break;
      }
      case 'printout':
      case 'note': {
        // nudged up-screen so paper scraps sit clear of the tile's front walls
        const img = scaleArt(
          this.add
            .image(p.sx, p.sy - 5, e.kind === 'printout' ? 'paper' : 'note')
            .setOrigin(0.5, 0.5)
            .setDepth(eDepth(-4)),
        );
        interactive(img, () =>
          openReader(e.kind === 'printout' ? 'PRINTOUT' : 'HANDWRITTEN NOTE', [
            e.text ?? '(blank)',
            ...(e.authorName ? [``, `— ${e.authorName}`] : []),
          ]),
        );
        objs.push(img);
        break;
      }
      case 'sign': {
        const img = scaleArt(
          this.add.image(p.sx, p.sy + 6, 'sign').setOrigin(0.5, 1).setDepth(eDepth()),
        );
        const arrow = this.add
          .text(p.sx, p.sy - 14, e.text?.replace('EXIT ', '') ?? '?', {
            fontFamily: 'Consolas, monospace',
            fontSize: '10px',
            color: '#1a1a0a',
          })
          .setOrigin(0.5)
          .setDepth(eDepth(1));
        interactive(img, () => openReader('SIGN', [e.text ?? '', '', 'It looks official. Probably.']));
        objs.push(img, arrow);
        break;
      }
      case 'crate': {
        const img = scaleArt(
          this.add.image(p.sx, p.sy + 6, 'crate').setOrigin(0.5, 1).setDepth(eDepth()),
        );
        if (isNew) {
          img.setY(p.sy - 220);
          this.tweens.add({
            targets: img,
            y: p.sy + 6,
            duration: 650,
            ease: 'Bounce.easeOut',
          });
        }
        interactive(img, () => openReader('SUPPLY CRATE', [e.text ?? 'A sealed supply crate.']));
        objs.push(img);
        break;
      }
      case 'corpse': {
        const img = scaleArt(
          this.add.image(p.sx, p.sy, 'corpse').setOrigin(0.5, 0.85).setDepth(eDepth(-4)),
        );
        interactive(img, () => openReader('REMAINS', [e.text ?? 'Somebody. Once.']));
        if (isNew) {
          img.setAlpha(0);
          this.tweens.add({ targets: img, alpha: 1, duration: 1200 });
        }
        objs.push(img);
        break;
      }
      case 'poster':
      case 'terminal_log': {
        const img = this.add
          .image(p.sx, p.sy, 'note')
          .setOrigin(0.5, 0.5)
          .setDepth(eDepth(-4));
        interactive(img, () => openReader(e.kind.toUpperCase(), [e.text ?? '']));
        objs.push(img);
        break;
      }
    }
    this.evidenceViews.set(e.id, objs);
  }

  /**
   * Render graffiti as spray paint PROJECTED onto the world: sheared onto a
   * neighboring wall plane when one exists, otherwise laid flat along the
   * isometric floor. One canvas texture per artifact.
   */
  private makeGraffiti(e: EvidenceArtifact): Phaser.GameObjects.Image {
    const key = `graf:${e.id}`;
    if (this.textures.exists(key)) this.textures.remove(key);
    const text = (e.text ?? '').slice(0, 42);
    const font = '13px "Segoe Print", "Bradley Hand", "Comic Sans MS", cursive';

    // measure roughly
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.font = font;
    const tw = Math.min(210, Math.ceil(probe.measureText(text).width) + 8);

    // wall behind the tile? paint it there; else on the carpet
    const c = this.store.chunks.get(chunkKey(tileToChunk(e.x), tileToChunk(e.y)));
    const li = (((e.y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE) * CHUNK_SIZE +
      (((e.x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE);
    const onWallH = c && c.wallsH[li] === EDGE.Wall;
    const onWallV = !onWallH && c && c.wallsV[li] === EDGE.Wall;

    const spray = (ctx: CanvasRenderingContext2D, x: number, y: number) => {
      ctx.font = font;
      ctx.textBaseline = 'middle';
      // soft overspray halo, then the strokes
      ctx.globalAlpha = 0.28;
      for (const [ox, oy] of [[-1.5, 0], [1.5, 0.8], [0, -1.4], [0.8, 1.2]]) {
        ctx.fillText(text, x + ox, y + oy);
      }
      ctx.globalAlpha = 0.92;
      ctx.fillText(text, x, y);
      // drips
      ctx.globalAlpha = 0.5;
      for (let i = 0; i < 3; i++) {
        const dx = x + 6 + ((i * 53) % Math.max(20, tw - 10));
        ctx.fillRect(dx, y + 6, 1.2, 4 + ((i * 29) % 7));
      }
      ctx.globalAlpha = 1;
    };

    if (onWallH || onWallV) {
      // upright on the wall plane, sheared to its slope
      const W = Math.min(tw + 8, 96);
      const H = 16 + WALL_H + Math.ceil(W / 2);
      const tex = this.textures.createCanvas(key, W, H)!;
      const ctx = tex.getContext();
      const slope = onWallH ? 0.5 : -0.5;
      const y0 = onWallH ? 16 : 16 + W / 2;
      ctx.setTransform(1, slope, 0, 1, 0, y0);
      ctx.fillStyle = '#b3312e';
      ctx.save();
      ctx.scale(Math.min(1, (W - 6) / tw), 1);
      spray(ctx, 3, WALL_H / 2 + 2);
      ctx.restore();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      tex.refresh();
      // anchor exactly like the wall planes: H edges origin(0,1), V edges origin(1,1)
      const img = this.add.image(0, 0, key).setOrigin(onWallH ? 0 : 1, 1);
      const gp = gridToScreen(Math.floor(e.x), Math.floor(e.y));
      img.setPosition(gp.sx, gp.sy);
      return img;
    }

    // floor: project along the iso ground plane
    const W = tw + 20;
    const H = Math.ceil(W * 0.62) + 16;
    const tex = this.textures.createCanvas(key, W, H)!;
    const ctx = tex.getContext();
    ctx.setTransform(0.9, 0.45, -0.55, 0.34, W / 2, H / 2 - 4);
    ctx.fillStyle = '#c23b2e';
    spray(ctx, -tw / 2, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    tex.refresh();
    const img = this.add.image(0, 0, key).setOrigin(0.5, 0.5);
    const pp = entityToScreen(e.x + 0.5, e.y + 0.5);
    img.setPosition(pp.sx, pp.sy);
    return img;
  }

  // ---------------- agents / monster / chaos ----------------

  private upsertAgent(a: Agent) {
    let v = this.agentViews.get(a.id);
    if (!v) {
      const p = entityToScreen(a.x, a.y);
      const color = Phaser.Display.Color.HSLToColor(a.hue / 360, 0.6, 0.62).color;
      const sprite = this.add
        .image(p.sx, p.sy + 10, 'agent')
        .setOrigin(0.5, 1)
        .setTint(color);
      sprite.setInteractive({ useHandCursor: true });
      sprite.on('pointerup', (pointer: Phaser.Input.Pointer) => {
        if (pointer.getDistance() < 8) this.tuneInto(a.id);
      });
      const label = this.add
        .text(p.sx, p.sy - 32, a.name, {
          fontFamily: 'Consolas, monospace',
          fontSize: '10px',
          color: `hsl(${a.hue}, 60%, 70%)`,
          stroke: '#000000',
          strokeThickness: 2,
        })
        .setOrigin(0.5);
      v = { sprite, label, gx: a.x, gy: a.y, queue: [], beamAngle: FACING_ANGLE.s! };
      this.agentViews.set(a.id, v);
    }
    const last = v.queue[v.queue.length - 1];
    if (!last || Math.abs(last.x - a.x) > 0.001 || Math.abs(last.y - a.y) > 0.001) {
      v.queue.push({ x: a.x, y: a.y });
    }
    if (a.state === 'dead') {
      v.sprite.setTint(0x333333);
      v.sprite.setAlpha(0.6);
    }
  }

  private updateMonster() {
    const m = this.store.monster;
    this.monsterView.setVisible(true);
    const t = this.monsterTrail;
    const last = t.queue[t.queue.length - 1];
    if (!last || Math.abs(last.x - m.x) > 0.001 || Math.abs(last.y - m.y) > 0.001) {
      t.queue.push({ x: m.x, y: m.y });
    }
  }

  private updateChaos() {
    const c = this.store.chaos;
    this.chaosView.setVisible(c.visible);
    if (c.visible) {
      const p = entityToScreen(c.x, c.y);
      this.chaosView.setPosition(p.sx, p.sy + 10).setDepth(depthOf(c.x, c.y, 2));
    }
  }

  // ---------------- thoughts & speech ----------------

  /** spawn a text above an agent that drifts upward until it leaves the screen */
  private spawnFloater(
    x: number,
    y: number,
    text: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
    vy = 22,
  ): Phaser.GameObjects.Text {
    const t = this.add
      .text(x + (Math.random() - 0.5) * 14, y, text, style)
      .setOrigin(0.5, 1)
      .setDepth(FLOATER_DEPTH)
      .setAlpha(0);
    this.tweens.add({ targets: t, alpha: 1, duration: 300 });
    this.floaters.push({ obj: t, vy, born: this.time.now });
    return t;
  }

  private showSpeech(agentId: string, text: string) {
    const v = this.agentViews.get(agentId);
    if (!v) return;
    this.spawnFloater(v.sprite.x, v.sprite.y - 46, `"${text}"`, {
      fontFamily: 'Consolas, monospace',
      fontSize: '11px',
      color: '#f2f2e0',
      backgroundColor: '#12100acc',
      padding: { x: 6, y: 3 },
      wordWrap: { width: 200 },
      align: 'center',
    });
  }

  private showThought(th: ThoughtEvent) {
    const v = this.agentViews.get(th.agentId);
    if (!v || this.tunedAgentId !== th.agentId) return;

    let text = th.text;
    let color = '#7dff9a';
    if (th.mindState === 'stressed') {
      color = '#ffc46b';
      text = text
        .split(' ')
        .map((w) => (Math.random() < 0.15 ? w.toUpperCase() : w))
        .join(' ');
    } else if (th.mindState === 'panicked') {
      color = '#ff5d5d';
      const words = text.split(' ');
      text = words
        .filter(() => Math.random() > 0.28)
        .join(' ')
        .replace(/([,.]) /g, '$1 — ');
      if (text.length < 4) text = words.slice(0, 2).join(' ') + ' —';
    } else if (th.mindState === 'deceptive') {
      color = '#c99aff';
    }

    const baseY = v.sprite.y - 58;
    const vy = th.mindState === 'panicked' ? 30 : 22;
    const t = this.spawnFloater(
      v.sprite.x,
      baseY,
      text,
      {
        fontFamily: 'Consolas, monospace',
        fontSize: '12px',
        fontStyle: 'italic',
        color,
        stroke: '#050503',
        strokeThickness: 3,
        wordWrap: { width: 230 },
        align: 'center',
      },
      vy,
    );
    if (th.mindState === 'deceptive') {
      this.spawnFloater(
        t.x,
        baseY + 13,
        `[but is ${th.actionLabel}]`,
        {
          fontFamily: 'Consolas, monospace',
          fontSize: '10px',
          color: '#8a8a99',
          stroke: '#050503',
          strokeThickness: 2,
        },
        vy,
      );
    }
    if (th.mindState === 'panicked') {
      this.tweens.add({ targets: t, x: '+=3', yoyo: true, repeat: 40, duration: 40 });
    } else if (th.mindState === 'stressed') {
      this.tweens.add({ targets: t, x: '+=1.5', yoyo: true, repeat: 24, duration: 70 });
    }
  }

  private tuneInto(agentId: string) {
    const a = this.store.agents.get(agentId);
    if (!a) return;
    this.followAgentId = agentId;
    if (this.tunedAgentId === agentId) return;
    this.tunedAgentId = agentId;
    this.sidebarDirty = true;
    playTuneIn(a.name, () => {
      this.conn.send({ t: 'tune_in', agentId });
    });
  }

  // ---------------- world events ----------------

  private handleWorldEvent(e: WorldEvent) {
    switch (e.type) {
      case 'viral_post': {
        const agentId = e.payload.agentId as string | undefined;
        const a = agentId ? this.store.agents.get(agentId) : undefined;
        toast(`⚡ attention surge${a ? `: ${a.name}` : ''} — the outside noticed`);
        const v = agentId ? this.agentViews.get(agentId) : undefined;
        if (v) {
          const em = this.add.particles(v.sprite.x, v.sprite.y - 20, 'spark', {
            speed: { min: 30, max: 90 },
            lifespan: 900,
            gravityY: -60,
            quantity: 2,
            duration: 1200,
            scale: { start: 1.4, end: 0 },
          });
          em.setDepth(depthOf(v.gx, v.gy, 6));
          this.time.delayedCall(2500, () => em.destroy());
        }
        this.cameras.main.flash(180, 255, 220, 120);
        break;
      }
      case 'agent_died': {
        toast(`☠ ${e.payload.name} — ${e.payload.cause}`);
        this.cameras.main.flash(220, 120, 0, 0);
        this.cameras.main.shake(250, 0.004);
        break;
      }
      case 'agent_spawned':
        this.sidebarDirty = true;
        break;
      case 'corridor_collapse':
        toast('🔥 somewhere, hallways collapsed');
        this.cameras.main.shake(320, 0.006);
        break;
      case 'buyback':
        toast('💡 power returns to the sector');
        break;
      case 'airdrop':
        toast('📦 something heavy fell, somewhere close');
        break;
      case 'liquidity_up':
      case 'map_expand': {
        if (e.type === 'liquidity_up') toast('🌊 the maze is growing');
        const cam = this.cameras.main;
        this.tweens.add({
          targets: cam,
          zoom: cam.zoom * 0.93,
          duration: 350,
          yoyo: true,
          ease: 'Sine.easeInOut',
        });
        break;
      }
      case 'door_unlock':
        toast('🔓 a door unlocked itself');
        break;
    }
  }

  // ---------------- input & camera ----------------

  private wireInput() {
    const cam = this.cameras.main;
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!pointer.isDown) return;
      this.dragDist += Math.abs(pointer.velocity.x) + Math.abs(pointer.velocity.y);
      cam.scrollX -= (pointer.x - pointer.prevPosition.x) / cam.zoom;
      cam.scrollY -= (pointer.y - pointer.prevPosition.y) / cam.zoom;
      if (pointer.getDistance() > 8) this.followAgentId = null;
    });
    this.input.on(
      'wheel',
      (_p: unknown, _o: unknown, _dx: number, dy: number) => {
        const z = Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.8, 3.4);
        cam.setZoom(z);
      },
    );
  }

  private wireUi() {
    initReader();
    initSpawnModal((agentId) => {
      // follow the newborn once it appears
      const tryFocus = (attempts: number) => {
        const a = this.store.agents.get(agentId);
        if (a) {
          const p = gridToScreen(a.x, a.y);
          this.cameras.main.pan(p.sx, p.sy, 600, 'Sine.easeInOut');
          this.followAgentId = agentId;
        } else if (attempts > 0) {
          this.time.delayedCall(300, () => tryFocus(attempts - 1));
        }
      };
      tryFocus(10);
    });
  }

  // ---------------- per-frame ----------------

  /** Advance a view position along its queued server-position trail. */
  private advanceAlongQueue(
    v: { gx: number; gy: number; queue: { x: number; y: number }[] },
    dt: number,
    baseSpeed: number,
  ) {
    // slight overspeed drains the queue; big backlogs (tab was hidden) drain faster
    let budget = (baseSpeed * dt) / 1000;
    if (v.queue.length > 4) budget *= 1 + (v.queue.length - 4) * 0.5;
    while (budget > 0 && v.queue.length > 0) {
      const t = v.queue[0]!;
      const d = Math.hypot(t.x - v.gx, t.y - v.gy);
      if (d > 4) {
        // teleport-scale jump: snap, do not glide through the world
        v.gx = t.x;
        v.gy = t.y;
        v.queue.shift();
        continue;
      }
      if (d <= budget) {
        v.gx = t.x;
        v.gy = t.y;
        budget -= d;
        v.queue.shift();
      } else {
        v.gx += ((t.x - v.gx) / d) * budget;
        v.gy += ((t.y - v.gy) / d) * budget;
        budget = 0;
      }
    }
  }

  update(_time: number, dt: number) {
    // agent motion: retrace the server's path samples (no corner cutting)
    for (const [id, v] of this.agentViews) {
      this.advanceAlongQueue(v, dt, 2.4);
      const p = entityToScreen(v.gx, v.gy);
      v.sprite.setPosition(p.sx, p.sy + 10).setDepth(depthOf(v.gx, v.gy, 2));
      v.label.setPosition(p.sx, p.sy - 32).setDepth(depthOf(v.gx, v.gy, 4));
      const a = this.store.agents.get(id);
      if (a && a.mindState === 'panicked' && a.state !== 'dead') {
        v.sprite.x += (Math.random() - 0.5) * 1.2;
      }
      if (a) {
        const target = FACING_ANGLE[a.facing] ?? v.beamAngle;
        let diff = target - v.beamAngle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        v.beamAngle += diff * Math.min(1, dt * 0.01);
      }
    }

    // monster: same trail-following, plus its unsettling jitter
    {
      const t = this.monsterTrail;
      this.advanceAlongQueue(t, dt, 2.8);
      const p = entityToScreen(t.gx, t.gy);
      this.monsterView
        .setPosition(p.sx + (Math.random() - 0.5) * 2, p.sy + 12 + (Math.random() - 0.5) * 1.5)
        .setDepth(depthOf(t.gx, t.gy, 2));
      this.monsterView.setVisible(true);
      // its eyes burn through the darkness even when the body is unseen
      this.monsterEyes
        .setPosition(p.sx - 3, p.sy - 60)
        .setVisible(Math.random() > 0.04)
        .setAlpha(0.75 + Math.random() * 0.25);
    }
    // chaos flicker
    if (this.chaosView.visible) {
      this.chaosView.setAlpha(0.4 + Math.random() * 0.6);
    }

    // camera follow
    if (this.followAgentId) {
      const v = this.agentViews.get(this.followAgentId);
      if (v) {
        const cam = this.cameras.main;
        const target = gridToScreen(v.gx, v.gy);
        cam.scrollX += (target.sx - cam.width / 2 / 1 - cam.scrollX) * 0.06;
        cam.scrollY += (target.sy - cam.height / 2 / 1 - cam.scrollY) * 0.06;
      }
    }

    // ---- the darkness: repaint the veil, then carve light out of it ----
    {
      const cam = this.cameras.main;
      const view = cam.worldView;
      const z = cam.zoom;
      const toScreen = (wx: number, wy: number) => ({
        x: (wx - view.x) * z,
        y: (wy - view.y) * z,
      });
      this.darkRT.clear();
      this.darkRT.fill(0x030304, 0.93);
      // powered sectors
      for (const [key, rec] of this.power) {
        if (rec.v <= 0.02) continue;
        const [cx, cy] = key.split(',').map(Number);
        const center = gridToScreen(cx! * CHUNK_SIZE + 8, cy! * CHUNK_SIZE + 8);
        const s = toScreen(center.sx, center.sy);
        if (s.x < -900 * z || s.x > this.scale.width + 900 * z) continue;
        if (s.y < -600 * z || s.y > this.scale.height + 600 * z) continue;
        this.eraserChunk.setScale(2.4 * z).setAlpha(rec.v);
        this.darkRT.erase(this.eraserChunk, s.x, s.y);
      }
      // flashlights: a cone in the facing direction plus a personal pool
      for (const v of this.agentViews.values()) {
        const s = toScreen(v.sprite.x, v.sprite.y - 12);
        this.eraserPool.setScale(0.9 * z).setAlpha(0.95);
        this.darkRT.erase(this.eraserPool, s.x, s.y);
        this.eraserCone.setRotation(v.beamAngle).setScale(1.05 * z).setAlpha(0.92);
        this.darkRT.erase(this.eraserCone, s.x, s.y);
      }
      // the chaos thing glows faintly when it manifests
      if (this.chaosView.visible) {
        const s = toScreen(this.chaosView.x, this.chaosView.y - 16);
        this.eraserPool.setScale(0.55 * z).setAlpha(0.55);
        this.darkRT.erase(this.eraserPool, s.x, s.y);
      }
    }

    // floating texts drift upward and dissolve at the top of the screen
    if (this.floaters.length > 0) {
      const camTop = this.cameras.main.worldView.top;
      for (let i = this.floaters.length - 1; i >= 0; i--) {
        const f = this.floaters[i]!;
        f.obj.y -= (f.vy * dt) / 1000;
        const distToTop = f.obj.y - camTop;
        if (distToTop < 110) f.obj.setAlpha(Math.max(0, distToTop - 20) / 90);
        if (distToTop < 20 || this.time.now - f.born > 60000) {
          f.obj.destroy();
          this.floaters.splice(i, 1);
        }
      }
    }

    // wall planes standing in front of agents or evidence go translucent
    {
      if (this.evidenceFadeDirty) {
        this.evidenceFadeDirty = false;
        this.evidenceFadeKeys.clear();
        for (const e of this.store.evidence.values()) {
          const tx = Math.floor(e.x);
          const ty = Math.floor(e.y);
          this.evidenceFadeKeys.add(`h:${tx},${ty + 1}`);
          this.evidenceFadeKeys.add(`v:${tx + 1},${ty}`);
          this.evidenceFadeKeys.add(`h:${tx + 1},${ty + 1}`);
          this.evidenceFadeKeys.add(`v:${tx + 1},${ty + 1}`);
        }
      }
      const fade = new Set<string>(this.evidenceFadeKeys);
      for (const v of this.agentViews.values()) {
        const tx = Math.floor(v.gx);
        const ty = Math.floor(v.gy);
        fade.add(`h:${tx},${ty + 1}`); // south wall of the agent's tile
        fade.add(`v:${tx + 1},${ty}`); // east wall
        fade.add(`h:${tx + 1},${ty + 1}`);
        fade.add(`v:${tx + 1},${ty + 1}`);
      }
      for (const wk of this.fadedWalls) {
        if (!fade.has(wk)) for (const img of this.wallIndex.get(wk) ?? []) img.setAlpha(1);
      }
      for (const wk of fade) {
        for (const img of this.wallIndex.get(wk) ?? []) {
          // door frames are already mostly open; fading them reads as a missing door
          if (!img.texture.key.startsWith('door')) img.setAlpha(0.45);
        }
      }
      this.fadedWalls = fade;
    }

    // chunk subscriptions follow the camera
    this.subTimer += dt;
    if (this.subTimer > 400) {
      this.subTimer = 0;
      this.updateSubscriptions();
    }

    // sidebar refresh (throttled)
    this.sidebarTimer += dt;
    if (this.sidebarTimer > 600 && this.sidebarDirty) {
      this.sidebarTimer = 0;
      this.sidebarDirty = false;
      renderAgentList([...this.store.agents.values()], this.tunedAgentId, {
        onAgentClick: (id) => this.tuneInto(id),
      });
    }
  }

  private updateSubscriptions() {
    const cam = this.cameras.main;
    const view = cam.worldView;
    const corners = [
      screenToGrid(view.left, view.top),
      screenToGrid(view.right, view.top),
      screenToGrid(view.left, view.bottom),
      screenToGrid(view.right, view.bottom),
    ];
    const minCx = Math.floor(Math.min(...corners.map((c) => c.x)) / CHUNK_SIZE) - 1;
    const maxCx = Math.floor(Math.max(...corners.map((c) => c.x)) / CHUNK_SIZE) + 1;
    const minCy = Math.floor(Math.min(...corners.map((c) => c.y)) / CHUNK_SIZE) - 1;
    const maxCy = Math.floor(Math.max(...corners.map((c) => c.y)) / CHUNK_SIZE) + 1;

    const coords: { cx: number; cy: number }[] = [];
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        coords.push({ cx, cy });
        if (coords.length >= 380) break;
      }
      if (coords.length >= 380) break;
    }
    const signature = `${minCx},${minCy},${maxCx},${maxCy}`;
    if (signature !== this.lastSubSignature) {
      this.lastSubSignature = signature;
      this.conn.send({ t: 'subscribe_chunks', coords });

      // drop far-away chunk views to bound memory
      for (const [key, view2] of this.chunkViews) {
        const [cx, cy] = key.split(',').map(Number);
        if (cx! < minCx - 3 || cx! > maxCx + 3 || cy! < minCy - 3 || cy! > maxCy + 3) {
          view2.rt.destroy();
          for (const sp of view2.sprites) sp.destroy();
          for (const wk of view2.wallKeys) this.wallIndex.delete(wk);
          this.chunkViews.delete(key);
          this.store.dropChunk(key);
        }
      }
    }
  }
}
