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
}

/** a text drifting upward until it leaves the top of the screen */
interface Floater {
  obj: Phaser.GameObjects.Text;
  vy: number; // world px/s upward
  born: number;
}

const DARK_TINT = 0x55566a;
const FLOATER_DEPTH = 5_000_000;

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
  /** chunk views needing a rebuild because a neighbor arrived or relit */
  private rebuildQueue = new Set<string>();
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
    this.cameras.main.setBackgroundColor('#0a0a08');
    this.cameras.main.setZoom(1.3);

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
    s.onChunk = (c) => {
      this.buildChunkView(c);
      this.queueNeighborRebuilds(c.cx, c.cy);
    };
    s.onChunkChanged = (key) => {
      const c = s.chunks.get(key);
      if (c) {
        this.buildChunkView(c);
        this.queueNeighborRebuilds(c.cx, c.cy);
      }
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
    s.onLight = (cx, cy, on) => this.flickerChunk(cx, cy, on);
    s.onWorldEvent = (e) => this.handleWorldEvent(e);
    s.onSpeech = (agentId, text) => this.showSpeech(agentId, text);
    s.onThought = (t) => this.showThought(t);
  }

  // ---------------- chunk rendering ----------------

  private queueNeighborRebuilds(cx: number, cy: number) {
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const key = chunkKey(cx + dx, cy + dy);
      if (this.chunkViews.has(key)) this.rebuildQueue.add(key);
    }
  }

  private chunkLight(cx: number, cy: number): number | null {
    const c = this.store.chunks.get(chunkKey(cx, cy));
    return c ? (c.lightsOn ? 1 : 0) : null;
  }

  /**
   * Per-tile brightness: bilinear blend of the four nearest chunks' light
   * states, so lit and dark sectors fade into each other instead of meeting
   * at a hard chunk-diamond edge. Coordinates are float tile positions.
   */
  private brightnessAt(tx: number, ty: number): number {
    const fx = tx / CHUNK_SIZE - 0.5;
    const fy = ty / CHUNK_SIZE - 0.5;
    const c0x = Math.floor(fx);
    const c0y = Math.floor(fy);
    const wx = fx - c0x;
    const wy = fy - c0y;
    const own = this.chunkLight(tileToChunk(Math.floor(tx)), tileToChunk(Math.floor(ty)));
    const s = (cx: number, cy: number) => this.chunkLight(cx, cy) ?? own ?? 1;
    return (
      s(c0x, c0y) * (1 - wx) * (1 - wy) +
      s(c0x + 1, c0y) * wx * (1 - wy) +
      s(c0x, c0y + 1) * (1 - wx) * wy +
      s(c0x + 1, c0y + 1) * wx * wy
    );
  }

  private tintFor(b: number): number {
    const t = Math.max(0, Math.min(1, b));
    const r = Math.round(0x55 + (0xff - 0x55) * t);
    const g = Math.round(0x56 + (0xff - 0x56) * t);
    const bl = Math.round(0x6a + (0xff - 0x6a) * t);
    return (r << 16) | (g << 8) | bl;
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

        // carpet everywhere, lit per tile so light fades across sector borders
        const tileTint = this.tintFor(this.brightnessAt(gx + 0.5, gy + 0.5));
        const floorKey = (gx + gy) % 2 === 0 ? 'floor0' : 'floor1';
        rt.draw(floorKey, p.sx - rtX - 32, p.sy - rtY - 16, 1, tileTint);
        if (t === TILE.Rubble) {
          const img = scaleArt(
            this.add
              .image(p.sx, p.sy, 'rubble')
              .setOrigin(0.5, 0.6)
              .setDepth(depthOf(gx + 0.5, gy + 0.5, -4))
              .setTint(tileTint),
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
            .setDepth(depthOf(gx + 0.5, gy, 0))
            .setTint(this.tintFor(this.brightnessAt(gx + 0.5, gy)));
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
            .setDepth(depthOf(gx, gy + 0.5, 0))
            .setTint(this.tintFor(this.brightnessAt(gx, gy + 0.5)));
          sprites.push(img);
          const wk = `v:${gx},${gy}`;
          this.wallIndex.set(wk, [img]);
          wallKeys.push(wk);
        }

        // fluorescent fixtures, sparser for a moodier found-footage look
        // (proper modulo: JS % is negative for negative coords, which used to
        // erase every fixture west/north of the origin)
        if (t === TILE.Floor && (((gx % 6) + 6) % 6) === 2 && (((gy % 6) + 6) % 6) === 3) {
          const b = this.brightnessAt(gx + 0.5, gy + 0.5);
          const bar = scaleArt(
            this.add
              .image(p.sx, p.sy - WALL_H - 10, c.lightsOn ? 'lightOn' : 'lightOff')
              .setDepth(depthOf(gx + 0.5, gy + 0.5, 20))
              // both states share one image; a cold dark tint sells "dead tubes"
              .setTint(c.lightsOn ? this.tintFor(Math.max(0.35, b)) : 0x3f4450),
          );
          sprites.push(bar);
          if (c.lightsOn) {
            const glow = this.add
              .image(p.sx, p.sy, 'glow')
              .setBlendMode(Phaser.BlendModes.ADD)
              .setScale(2.2, 1.4)
              .setAlpha(Math.max(0.2, b))
              .setDepth(depthOf(gx + 0.5, gy + 0.5, -6));
            sprites.push(glow);
          }
        }
      }
    }
    this.chunkViews.set(key, { rt, sprites, wallKeys, version: c.version });
  }

  private flickerChunk(cx: number, cy: number, on: boolean) {
    const c = this.store.chunks.get(chunkKey(cx, cy));
    if (!c) return;
    // rebuild with new light state after a flicker
    let count = 0;
    const timer = this.time.addEvent({
      delay: 70,
      repeat: 5,
      callback: () => {
        count++;
        const view = this.chunkViews.get(chunkKey(cx, cy));
        if (view) {
          const tint = count % 2 === 0 ? 0xffffff : DARK_TINT;
          view.rt.setTint(tint);
        }
        if (count > 5) {
          timer.destroy();
          this.buildChunkView(c);
          this.queueNeighborRebuilds(cx, cy); // light gradient bleeds into neighbors
        }
      },
    });
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
        const short = (e.text ?? '').slice(0, 16) + ((e.text?.length ?? 0) > 16 ? '…' : '');
        const txt = this.add
          .text(p.sx, p.sy - 20, short, {
            fontFamily: 'Consolas, monospace',
            fontSize: '11px',
            color: '#c23b2e',
            stroke: '#1a0a08',
            strokeThickness: 2,
          })
          .setOrigin(0.5)
          .setAngle(-12)
          .setDepth(eDepth(-2));
        interactive(txt, () =>
          openReader('GRAFFITI', [
            `"${e.text ?? ''}"`,
            e.authorName ? `— scratched by ${e.authorName}` : '— author unknown',
          ]),
        );
        objs.push(txt);
        break;
      }
      case 'crt': {
        const img = scaleArt(
          this.add.image(p.sx, p.sy + 6, 'crt').setOrigin(0.5, 1).setDepth(eDepth()),
        );
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
      v = { sprite, label, gx: a.x, gy: a.y, queue: [] };
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
        const z = Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.4, 2.2);
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

    // rebuild chunks whose lighting context changed (neighbor arrived/relit)
    if (this.rebuildQueue.size > 0) {
      for (const key of this.rebuildQueue) {
        const c = this.store.chunks.get(key);
        if (c && this.chunkViews.has(key)) this.buildChunkView(c);
      }
      this.rebuildQueue.clear();
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
