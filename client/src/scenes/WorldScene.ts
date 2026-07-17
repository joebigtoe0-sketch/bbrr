import Phaser from 'phaser';
import { CHUNK_SIZE, TILE, chunkKey } from '@backrooms/shared';
import type { Agent, EvidenceArtifact, MazeChunk, ThoughtEvent, WorldEvent } from '@backrooms/shared';
import { WorldStore } from '../state/worldStore.js';
import { Connection } from '../net/connection.js';
import { FLOOR_DEPTH, WALL_H, depthOf, gridToScreen, screenToGrid } from '../render/iso.js';
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
  version: number;
}

interface AgentView {
  sprite: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text;
  gx: number;
  gy: number;
  tx: number;
  ty: number;
  speech: Phaser.GameObjects.Text | null;
  thoughtStack: number;
}

const DARK_TINT = 0x55566a;

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
    this.cameras.main.setZoom(1);

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
        v.speech?.destroy();
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
        v.speech?.destroy();
        this.agentViews.delete(id);
      }
      if (this.tunedAgentId === id) this.tunedAgentId = null;
      if (this.followAgentId === id) this.followAgentId = null;
      this.sidebarDirty = true;
    };
    s.onMonster = () => this.updateMonster();
    s.onChaos = () => this.updateChaos();
    s.onEvidence = (e, isNew) => this.upsertEvidence(e, isNew);
    s.onEvidenceRemove = (id) => {
      for (const o of this.evidenceViews.get(id) ?? []) o.destroy();
      this.evidenceViews.delete(id);
    };
    s.onLight = (cx, cy, on) => this.flickerChunk(cx, cy, on);
    s.onWorldEvent = (e) => this.handleWorldEvent(e);
    s.onSpeech = (agentId, text) => this.showSpeech(agentId, text);
    s.onThought = (t) => this.showThought(t);
  }

  // ---------------- chunk rendering ----------------

  private buildChunkView(c: MazeChunk) {
    const key = chunkKey(c.cx, c.cy);
    const old = this.chunkViews.get(key);
    if (old) {
      old.rt.destroy();
      for (const sp of old.sprites) sp.destroy();
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
    const dark = !c.lightsOn;

    for (let ly = 0; ly < S; ly++) {
      for (let lx = 0; lx < S; lx++) {
        const t = c.tiles[ly * S + lx]!;
        if (t === TILE.Void) continue;
        const gx = origin.gx + lx;
        const gy = origin.gy + ly;
        const p = gridToScreen(gx, gy);

        if (t === TILE.Floor || t === TILE.DoorOpen || t === TILE.Rubble) {
          const floorKey = (gx + gy) % 2 === 0 ? 'floor0' : 'floor1';
          rt.draw(floorKey, p.sx - rtX - 32, p.sy - rtY - 16);
        }
        if (t === TILE.Wall) {
          const img = this.add
            .image(p.sx, p.sy + 16, 'wall')
            .setOrigin(0.5, 1)
            .setDepth(depthOf(gx, gy));
          if (dark) img.setTint(DARK_TINT);
          sprites.push(img);
        } else if (t === TILE.DoorOpen || t === TILE.DoorLocked) {
          const img = this.add
            .image(p.sx, p.sy + 16, t === TILE.DoorOpen ? 'doorOpen' : 'doorLocked')
            .setOrigin(0.5, 1)
            .setDepth(depthOf(gx, gy));
          if (dark) img.setTint(DARK_TINT);
          sprites.push(img);
        } else if (t === TILE.Rubble) {
          const img = this.add
            .image(p.sx, p.sy, 'rubble')
            .setOrigin(0.5, 0.5)
            .setDepth(depthOf(gx, gy, -2));
          if (dark) img.setTint(DARK_TINT);
          sprites.push(img);
        }

        // fluorescent fixtures on a sparse deterministic grid
        if (t === TILE.Floor && gx % 4 === 1 && gy % 4 === 2) {
          const bar = this.add
            .image(p.sx, p.sy - WALL_H - 6, c.lightsOn ? 'lightOn' : 'lightOff')
            .setDepth(depthOf(gx, gy, 7));
          sprites.push(bar);
          if (c.lightsOn) {
            const glow = this.add
              .image(p.sx, p.sy, 'glow')
              .setBlendMode(Phaser.BlendModes.ADD)
              .setScale(1.6, 1.0)
              .setDepth(depthOf(gx, gy, -1));
            sprites.push(glow);
          }
        }
      }
    }
    if (dark) rt.setTint(DARK_TINT);
    this.chunkViews.set(key, { rt, sprites, version: c.version });
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
        }
      },
    });
  }

  // ---------------- evidence rendering ----------------

  private upsertEvidence(e: EvidenceArtifact, isNew: boolean) {
    for (const o of this.evidenceViews.get(e.id) ?? []) o.destroy();
    const p = gridToScreen(e.x + 0.5, e.y + 0.5);
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
          .setDepth(depthOf(e.x, e.y, 1));
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
        const img = this.add
          .image(p.sx, p.sy + 6, 'crt')
          .setOrigin(0.5, 1)
          .setDepth(depthOf(e.x, e.y));
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
        const img = this.add
          .image(p.sx, p.sy + 4, 'printer')
          .setOrigin(0.5, 1)
          .setDepth(depthOf(e.x, e.y));
        interactive(img, () => openReader('PRINTER', ['An old printer. It hums, waiting.']));
        objs.push(img);
        break;
      }
      case 'printout':
      case 'note': {
        const img = this.add
          .image(p.sx, p.sy, e.kind === 'printout' ? 'paper' : 'note')
          .setOrigin(0.5, 0.5)
          .setDepth(depthOf(e.x, e.y, -1));
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
        const img = this.add
          .image(p.sx, p.sy + 6, 'sign')
          .setOrigin(0.5, 1)
          .setDepth(depthOf(e.x, e.y));
        const arrow = this.add
          .text(p.sx, p.sy - 14, e.text?.replace('EXIT ', '') ?? '?', {
            fontFamily: 'Consolas, monospace',
            fontSize: '10px',
            color: '#1a1a0a',
          })
          .setOrigin(0.5)
          .setDepth(depthOf(e.x, e.y, 1));
        interactive(img, () => openReader('SIGN', [e.text ?? '', '', 'It looks official. Probably.']));
        objs.push(img, arrow);
        break;
      }
      case 'crate': {
        const img = this.add
          .image(p.sx, p.sy + 6, 'crate')
          .setOrigin(0.5, 1)
          .setDepth(depthOf(e.x, e.y));
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
        const img = this.add
          .image(p.sx, p.sy, 'corpse')
          .setOrigin(0.5, 0.5)
          .setDepth(depthOf(e.x, e.y, -1));
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
          .setDepth(depthOf(e.x, e.y, -1));
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
      const p = gridToScreen(a.x, a.y);
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
      v = { sprite, label, gx: a.x, gy: a.y, tx: a.x, ty: a.y, speech: null, thoughtStack: 0 };
      this.agentViews.set(a.id, v);
    }
    v.tx = a.x;
    v.ty = a.y;
    if (a.state === 'dead') {
      v.sprite.setTint(0x333333);
      v.sprite.setAlpha(0.6);
    }
  }

  private updateMonster() {
    const m = this.store.monster;
    this.monsterView.setVisible(true);
    const p = gridToScreen(m.x, m.y);
    this.monsterView.setPosition(p.sx, p.sy + 12).setDepth(depthOf(m.x, m.y, 2));
  }

  private updateChaos() {
    const c = this.store.chaos;
    this.chaosView.setVisible(c.visible);
    if (c.visible) {
      const p = gridToScreen(c.x, c.y);
      this.chaosView.setPosition(p.sx, p.sy + 10).setDepth(depthOf(c.x, c.y, 2));
    }
  }

  // ---------------- thoughts & speech ----------------

  private showSpeech(agentId: string, text: string) {
    const v = this.agentViews.get(agentId);
    if (!v) return;
    v.speech?.destroy();
    const t = this.add
      .text(v.sprite.x, v.sprite.y - 46, `"${text}"`, {
        fontFamily: 'Consolas, monospace',
        fontSize: '11px',
        color: '#f2f2e0',
        backgroundColor: '#12100acc',
        padding: { x: 6, y: 3 },
        wordWrap: { width: 200 },
        align: 'center',
      })
      .setOrigin(0.5, 1)
      .setDepth(depthOf(v.gx, v.gy, 4));
    v.speech = t;
    this.tweens.add({ targets: t, alpha: 0, delay: 3800, duration: 700, onComplete: () => t.destroy() });
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

    const stackOffset = (v.thoughtStack % 3) * 44;
    v.thoughtStack++;
    const baseY = v.sprite.y - 58 - stackOffset;
    const t = this.add
      .text(v.sprite.x, baseY, text, {
        fontFamily: 'Consolas, monospace',
        fontSize: '12px',
        fontStyle: 'italic',
        color,
        stroke: '#050503',
        strokeThickness: 3,
        wordWrap: { width: 230 },
        align: 'center',
      })
      .setOrigin(0.5, 1)
      .setDepth(depthOf(v.gx, v.gy, 5))
      .setAlpha(0);
    const objs: Phaser.GameObjects.GameObject[] = [t];

    if (th.mindState === 'deceptive') {
      const contradiction = this.add
        .text(v.sprite.x, baseY + 13, `[but is ${th.actionLabel}]`, {
          fontFamily: 'Consolas, monospace',
          fontSize: '10px',
          color: '#8a8a99',
          stroke: '#050503',
          strokeThickness: 2,
        })
        .setOrigin(0.5, 1)
        .setDepth(depthOf(v.gx, v.gy, 5))
        .setAlpha(0);
      objs.push(contradiction);
    }

    for (const o of objs) {
      this.tweens.add({ targets: o, alpha: 1, duration: 300 });
      this.tweens.add({
        targets: o,
        y: '-=26',
        delay: 600,
        duration: 3600,
        ease: 'Sine.easeOut',
      });
      this.tweens.add({
        targets: o,
        alpha: 0,
        delay: 3600,
        duration: 900,
        onComplete: () => o.destroy(),
      });
    }
    if (th.mindState === 'panicked') {
      this.tweens.add({
        targets: t,
        x: '+=3',
        yoyo: true,
        repeat: 20,
        duration: 40,
      });
    } else if (th.mindState === 'stressed') {
      this.tweens.add({ targets: t, x: '+=1.5', yoyo: true, repeat: 12, duration: 70 });
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

  update(_time: number, dt: number) {
    // agent motion interpolation
    for (const [id, v] of this.agentViews) {
      v.gx += (v.tx - v.gx) * Math.min(1, dt * 0.012);
      v.gy += (v.ty - v.gy) * Math.min(1, dt * 0.012);
      const p = gridToScreen(v.gx, v.gy);
      v.sprite.setPosition(p.sx, p.sy + 10).setDepth(depthOf(v.gx, v.gy, 2));
      v.label.setPosition(p.sx, p.sy - 32).setDepth(depthOf(v.gx, v.gy, 4));
      if (v.speech) v.speech.setPosition(p.sx, p.sy - 46);
      const a = this.store.agents.get(id);
      if (a && a.mindState === 'panicked' && a.state !== 'dead') {
        v.sprite.x += (Math.random() - 0.5) * 1.2;
      }
    }

    // monster drift + jitter
    {
      const m = this.store.monster;
      const p = gridToScreen(m.x, m.y);
      this.monsterView
        .setPosition(p.sx + (Math.random() - 0.5) * 2, p.sy + 12 + (Math.random() - 0.5) * 1.5)
        .setDepth(depthOf(m.x, m.y, 2));
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
          this.chunkViews.delete(key);
          this.store.dropChunk(key);
        }
      }
    }
  }
}
