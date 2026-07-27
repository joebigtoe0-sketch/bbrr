import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CHUNK_SIZE, EDGE, TILE, chunkKey } from '@backrooms/shared';
import type { Agent, EvidenceArtifact, MazeChunk } from '@backrooms/shared';
import { WorldStore } from '../state/worldStore.js';
import { Connection } from '../net/connection.js';
import { WALL_H, ISO_DIR } from './iso.js';

/**
 * Three.js renderer for the world. Real geometry (floors + edge walls) lit by
 * real lights with shadow maps — so light physically cannot cross a wall. The
 * DOM UI (panels, HUD, sidebar) and the store/connection are unchanged; this
 * replaces only the in-world rendering.
 */

interface ChunkMesh {
  group: THREE.Group;
  version: number;
  lights: THREE.PointLight[];
}
interface AgentObj {
  sprite: THREE.Mesh;
  spot: THREE.SpotLight;
  target: THREE.Object3D;
  gx: number;
  gy: number;
  tx: number;
  ty: number;
  facing: string;
  battery: number;
}

const VIEW_SIZE = 14; // world units visible vertically at zoom 1

export class ThreeWorld {
  readonly store = new WorldStore();
  private conn = new Connection(this.store);
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam: THREE.OrthographicCamera;
  private target = new THREE.Vector3(8, 0, 8);
  private zoom = 1;
  private followId: string | null = null;

  private chunkMeshes = new Map<string, ChunkMesh>();
  private agents = new Map<string, AgentObj>();
  private evidence = new Map<string, THREE.Object3D>();
  private monster!: THREE.Mesh;
  private chaos!: THREE.Mesh;

  private floorTex!: THREE.Texture;
  private wallMat!: THREE.MeshStandardMaterial;
  private texCache = new Map<string, THREE.Texture>();
  private raycaster = new THREE.Raycaster();
  private billboards = new Set<THREE.Mesh>();

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x040406, 1);
    this.scene.fog = new THREE.Fog(0x040406, 34, 74);
    container.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.AmbientLight(0x161a24, 0.5));
    this.scene.add(new THREE.HemisphereLight(0x242c3a, 0x070709, 0.35));

    const aspect = window.innerWidth / window.innerHeight;
    this.cam = new THREE.OrthographicCamera(
      -VIEW_SIZE * aspect,
      VIEW_SIZE * aspect,
      VIEW_SIZE,
      -VIEW_SIZE,
      -200,
      400,
    );
    this.scene.add(this.cam);

    this.buildMaterials();
    this.monster = this.makeBillboard(this.monsterTexture(), 1.5, 2.3, { castShadow: true });
    this.monster.visible = false;
    this.scene.add(this.monster);
    this.chaos = this.makeBillboard(this.chaosTexture(), 1.0, 1.6, { emissive: 0x6a1a6a });
    this.chaos.visible = false;
    this.scene.add(this.chaos);

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.wireStore();
    this.wireInput();
    this.conn.onOpen = () => {};
    this.conn.connect();
    this.renderer.setAnimationLoop((t) => this.frame(t));
    (window as unknown as { __w: unknown }).__w = this;
  }

  // ---------------- materials / textures ----------------

  private buildMaterials() {
    const loader = new THREE.TextureLoader();
    this.floorTex = loader.load('/sprites/generated/floor_carpet.png');
    this.floorTex.wrapS = this.floorTex.wrapT = THREE.RepeatWrapping;
    this.floorTex.repeat.set(0.25, 0.25);
    this.floorTex.colorSpace = THREE.SRGBColorSpace;
    const wp = loader.load('/sprites/generated/wallpaper_strip.png');
    wp.wrapS = wp.wrapT = THREE.RepeatWrapping;
    wp.repeat.set(1, 1);
    wp.colorSpace = THREE.SRGBColorSpace;
    this.wallMat = new THREE.MeshStandardMaterial({ map: wp, color: 0xccc08a, roughness: 0.95, metalness: 0 });
  }

  private tex(url: string): THREE.Texture {
    let t = this.texCache.get(url);
    if (!t) {
      t = new THREE.TextureLoader().load(url);
      t.colorSpace = THREE.SRGBColorSpace;
      t.magFilter = THREE.NearestFilter;
      this.texCache.set(url, t);
    }
    return t;
  }

  private canvasTex(draw: (ctx: CanvasRenderingContext2D, s: number) => void, size = 64): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d')!, size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  private monsterTexture() {
    return this.canvasTex((ctx, s) => {
      ctx.fillStyle = '#0a0a12';
      ctx.beginPath();
      ctx.ellipse(s / 2, s * 0.62, s * 0.22, s * 0.42, 0, 0, 7);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(s / 2, s * 0.3, s * 0.16, s * 0.22, 0, 0, 7);
      ctx.fill();
      ctx.fillStyle = '#ff2a2a';
      ctx.beginPath();
      ctx.arc(s * 0.44, s * 0.28, s * 0.03, 0, 7);
      ctx.arc(s * 0.56, s * 0.28, s * 0.03, 0, 7);
      ctx.fill();
    });
  }
  private chaosTexture() {
    return this.canvasTex((ctx, s) => {
      ctx.fillStyle = 'rgba(208,38,201,0.9)';
      ctx.fillRect(s * 0.32, s * 0.2, s * 0.36, s * 0.62);
      ctx.beginPath();
      ctx.arc(s / 2, s * 0.22, s * 0.16, 0, 7);
      ctx.fill();
      ctx.fillStyle = 'rgba(43,226,216,0.8)';
      ctx.fillRect(s * 0.28, s * 0.4, s * 0.44, 3);
      ctx.fillRect(s * 0.28, s * 0.6, s * 0.44, 3);
    });
  }
  private agentTexture(hue: number) {
    return this.canvasTex((ctx, s) => {
      const col = `hsl(${hue}, 60%, 62%)`;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.roundRect(s * 0.34, s * 0.28, s * 0.32, s * 0.5, 8);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(s / 2, s * 0.26, s * 0.15, 0, 7);
      ctx.fill();
      ctx.fillStyle = '#111';
      ctx.fillRect(s * 0.44, s * 0.22, 3, 3);
      ctx.fillRect(s * 0.54, s * 0.22, 3, 3);
    });
  }

  /**
   * A lit, camera-facing billboard plane (not a Sprite) so it responds to
   * the real lights: dark when unlit (the monster genuinely hides), bright in
   * a flashlight. Anchored at its feet. `emissive` keeps a subject faintly
   * self-lit (agents) so it never fully vanishes.
   */
  private makeBillboard(
    map: THREE.Texture,
    w: number,
    h: number,
    opts: { emissive?: number; castShadow?: boolean } = {},
  ): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(w, h);
    geo.translate(0, h / 2, 0);
    const mat = new THREE.MeshStandardMaterial({
      map,
      transparent: true,
      alphaTest: 0.35,
      roughness: 1,
      metalness: 0,
      emissive: new THREE.Color(opts.emissive ?? 0x000000),
      emissiveMap: opts.emissive ? map : null,
      emissiveIntensity: opts.emissive ? 0.35 : 0,
      side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = opts.castShadow ?? false;
    this.billboards.add(m);
    return m;
  }

  private dropBillboard(m: THREE.Mesh) {
    this.billboards.delete(m);
    this.scene.remove(m);
  }

  // ---------------- store wiring ----------------

  private wireStore() {
    const s = this.store;
    s.onSnapshot = () => {
      for (const a of this.agents.values()) {
        this.dropBillboard(a.sprite);
        this.scene.remove(a.spot, a.target);
      }
      this.agents.clear();
      for (const a of s.agents.values()) this.upsertAgent(a);
      this.updateMonster();
      this.updateChaos();
      if (!this.followId) {
        const first = [...s.agents.values()][0];
        if (first) this.target.set(first.x, 0, first.y);
      }
    };
    s.onChunk = (c) => this.buildChunk(c);
    s.onChunkChanged = (key) => {
      const c = s.chunks.get(key);
      if (c) this.buildChunk(c);
    };
    s.onAgent = (a) => this.upsertAgent(a);
    s.onAgentRemove = (id) => {
      const a = this.agents.get(id);
      if (a) {
        this.dropBillboard(a.sprite);
        this.scene.remove(a.spot, a.target);
        this.agents.delete(id);
      }
    };
    s.onMonster = () => this.updateMonster();
    s.onChaos = () => this.updateChaos();
    s.onEvidence = (e) => this.upsertEvidence(e);
    s.onEvidenceRemove = (id) => {
      const o = this.evidence.get(id);
      if (o) {
        if (o instanceof THREE.Mesh) this.dropBillboard(o);
        else this.scene.remove(o);
        this.evidence.delete(id);
      }
    };
    s.onLight = () => {
      // rebuild the affected chunk's fixtures on power change
      for (const c of s.chunks.values()) this.refreshChunkLights(c);
    };
  }

  // ---------------- chunk geometry ----------------

  private buildChunk(c: MazeChunk) {
    const key = chunkKey(c.cx, c.cy);
    const old = this.chunkMeshes.get(key);
    if (old) {
      this.scene.remove(old.group);
      old.group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    }
    const group = new THREE.Group();
    const S = CHUNK_SIZE;
    const ox = c.cx * S;
    const oy = c.cy * S;

    // floor
    const floorGeo = new THREE.PlaneGeometry(S, S);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = new THREE.MeshStandardMaterial({
      map: this.floorTex.clone(),
      roughness: 1,
      metalness: 0,
      color: 0xffffff,
    });
    (floorMat.map as THREE.Texture).needsUpdate = true;
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.set(ox + S / 2 - 0.5, 0, oy + S / 2 - 0.5);
    floor.receiveShadow = true;
    group.add(floor);

    // walls: merge all edge boxes into one shadow-casting mesh
    const boxes: THREE.BufferGeometry[] = [];
    for (let ly = 0; ly < S; ly++) {
      for (let lx = 0; lx < S; lx++) {
        const i = ly * S + lx;
        const gx = ox + lx;
        const gy = oy + ly;
        const eh = c.wallsH[i]!;
        if (eh === EDGE.Wall || eh === EDGE.DoorLocked) {
          const g = new THREE.BoxGeometry(1, WALL_H, 0.08);
          g.translate(gx, WALL_H / 2, gy - 0.5);
          boxes.push(g);
        }
        const ev = c.wallsV[i]!;
        if (ev === EDGE.Wall || ev === EDGE.DoorLocked) {
          const g = new THREE.BoxGeometry(0.08, WALL_H, 1);
          g.translate(gx - 0.5, WALL_H / 2, gy);
          boxes.push(g);
        }
      }
    }
    if (boxes.length) {
      const merged = mergeGeometries(boxes);
      boxes.forEach((b) => b.dispose());
      const wall = new THREE.Mesh(merged, this.wallMat);
      wall.castShadow = true;
      wall.receiveShadow = true;
      group.add(wall);
    }

    this.scene.add(group);
    const cm: ChunkMesh = { group, version: c.version, lights: [] };
    this.chunkMeshes.set(key, cm);
    this.refreshChunkLights(c);
  }

  /** ceiling fixtures as real point lights in powered rooms */
  private refreshChunkLights(c: MazeChunk) {
    const key = chunkKey(c.cx, c.cy);
    const cm = this.chunkMeshes.get(key);
    if (!cm) return;
    for (const l of cm.lights) this.scene.remove(l);
    cm.lights = [];
    if (!c.lightsOn) return;
    const S = CHUNK_SIZE;
    for (let ly = 0; ly < S; ly++) {
      for (let lx = 0; lx < S; lx++) {
        const gx = c.cx * S + lx;
        const gy = c.cy * S + ly;
        if (
          c.tiles[ly * S + lx] === TILE.Floor &&
          (((gx % 6) + 6) % 6) === 2 &&
          (((gy % 6) + 6) % 6) === 3
        ) {
          if (this.totalRoomLights() >= 26) return; // GPU light budget
          const light = new THREE.PointLight(0xffe6b0, 26, 5.5, 1.1);
          light.position.set(gx, WALL_H - 0.1, gy);
          cm.lights.push(light);
          this.scene.add(light);
        }
      }
    }
  }

  private totalRoomLights(): number {
    let n = 0;
    for (const cm of this.chunkMeshes.values()) n += cm.lights.length;
    return n;
  }

  // ---------------- entities ----------------

  private upsertAgent(a: Agent) {
    let o = this.agents.get(a.id);
    if (!o) {
      const hueCol = new THREE.Color().setHSL(a.hue / 360, 0.55, 0.35).getHex();
      const sprite = this.makeBillboard(this.agentTexture(a.hue), 0.75, 1.05, { emissive: hueCol });
      sprite.position.set(a.x, 0, a.y);
      this.scene.add(sprite);
      const spot = new THREE.SpotLight(0xffe9b8, 140, 9, Math.PI / 4.5, 0.45, 1.0);
      spot.castShadow = true;
      spot.shadow.mapSize.set(512, 512);
      spot.shadow.camera.near = 0.2;
      spot.shadow.camera.far = 11;
      const target = new THREE.Object3D();
      this.scene.add(spot, target);
      spot.target = target;
      o = { sprite, spot, target, gx: a.x, gy: a.y, tx: a.x, ty: a.y, facing: a.facing, battery: a.battery };
      this.agents.set(a.id, o);
    }
    o.tx = a.x;
    o.ty = a.y;
    o.facing = a.facing;
    o.battery = a.battery;
    if (a.state === 'dead') (o.sprite.material as THREE.MeshStandardMaterial).opacity = 0.4;
  }

  private updateMonster() {
    const m = this.store.monster;
    this.monster.visible = true;
    this.monster.position.set(m.x, 0, m.y);
  }
  private updateChaos() {
    const c = this.store.chaos;
    this.chaos.visible = c.visible;
    if (c.visible) this.chaos.position.set(c.x, 0, c.y);
  }

  private upsertEvidence(e: EvidenceArtifact) {
    const existing = this.evidence.get(e.id);
    if (existing) this.scene.remove(existing);
    const url = EVIDENCE_TEX[e.kind];
    let obj: THREE.Object3D;
    if (url) {
      obj = this.makeBillboard(this.tex(url), 0.7, 0.9, { emissive: e.kind === 'crt' ? 0x0a3315 : 0 });
    } else {
      // graffiti / notes: a small flat marker on the floor
      const geo = new THREE.PlaneGeometry(0.5, 0.5);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({
        color: e.kind === 'graffiti' ? 0xc23b2e : 0xd8d0a0,
        transparent: true,
        opacity: 0.8,
      });
      obj = new THREE.Mesh(geo, mat);
    }
    obj.position.set(e.x + 0.5, 0.02, e.y + 0.5);
    obj.userData.evidenceId = e.id;
    this.scene.add(obj);
    this.evidence.set(e.id, obj);
  }

  // ---------------- camera / input ----------------

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    const aspect = w / h;
    this.cam.left = -VIEW_SIZE * aspect;
    this.cam.right = VIEW_SIZE * aspect;
    this.cam.top = VIEW_SIZE;
    this.cam.bottom = -VIEW_SIZE;
    this.cam.updateProjectionMatrix();
  }

  private wireInput() {
    const el = this.renderer.domElement;
    let dragging = false;
    let moved = 0;
    let lx = 0;
    let ly = 0;
    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      moved = 0;
      lx = e.clientX;
      ly = e.clientY;
    });
    window.addEventListener('pointerup', (e) => {
      if (dragging && moved < 6) this.onClick(e);
      dragging = false;
    });
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      // pan on the ground plane (screen-right and screen-down map to iso axes)
      const k = (VIEW_SIZE * 2) / window.innerHeight / this.zoom;
      this.followId = null;
      this.target.x -= (dx * 0.5 - dy) * k * 0.5;
      this.target.z -= (-dx * 0.5 - dy) * k * 0.5;
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = THREE.MathUtils.clamp(this.zoom * (e.deltaY > 0 ? 0.9 : 1.1), 0.5, 4);
    });
  }

  private onClick(e: PointerEvent) {
    const ndc = new THREE.Vector2(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.cam);
    // agents first (tune-in)
    const agentSprites = [...this.agents.entries()].map(([id, o]) => ((o.sprite.userData.id = id), o.sprite));
    const hitA = this.raycaster.intersectObjects(agentSprites, false)[0];
    if (hitA) {
      this.onTuneIn?.((hitA.object as THREE.Sprite).userData.id as string);
      return;
    }
    // otherwise the ground point (for chaos steering / evidence)
    const evObjs = [...this.evidence.values()];
    const hitE = this.raycaster.intersectObjects(evObjs, false)[0];
    if (hitE) {
      this.onEvidenceClick?.(hitE.object.userData.evidenceId as string);
      return;
    }
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const p = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(ground, p)) this.onGroundClick?.(p.x, p.z);
  }

  onTuneIn?: (id: string) => void;
  onEvidenceClick?: (id: string) => void;
  onGroundClick?: (x: number, z: number) => void;

  /** project a world position to screen pixels for HTML overlays */
  worldToScreen(x: number, y: number, z = 1): { x: number; y: number } {
    const v = new THREE.Vector3(x, z, y).project(this.cam);
    return {
      x: (v.x * 0.5 + 0.5) * window.innerWidth,
      y: (-v.y * 0.5 + 0.5) * window.innerHeight,
    };
  }

  setFollow(id: string | null) {
    this.followId = id;
  }
  send(msg: unknown) {
    this.conn.send(msg as never);
  }
  viewCenterTile() {
    return { x: this.target.x, y: this.target.z };
  }
  agentScreenPos(id: string) {
    const a = this.agents.get(id);
    return a ? this.worldToScreen(a.gx, a.gy, 1.2) : null;
  }
  monsterScreenPos() {
    const m = this.store.monster;
    return this.worldToScreen(m.x, m.y, 2.4);
  }
  agentHead(id: string) {
    const a = this.agents.get(id);
    return a ? this.worldToScreen(a.gx, a.gy, 1.15) : null;
  }

  // ---------------- per-frame ----------------

  private frame(_t: number) {
    // interpolate agents + drive their flashlights
    for (const o of this.agents.values()) {
      o.gx += (o.tx - o.gx) * 0.2;
      o.gy += (o.ty - o.gy) * 0.2;
      o.sprite.position.set(o.gx, 0, o.gy);
      const bf = o.battery <= 0 ? 0.3 : 0.4 + 0.6 * (o.battery / 100);
      o.spot.position.set(o.gx, WALL_H + 0.4, o.gy);
      o.spot.intensity = 160 * bf;
      o.spot.distance = 10 * bf;
      const fd = FACE[o.facing] ?? [0, 1];
      o.target.position.set(o.gx + fd[0] * 3, 0, o.gy + fd[1] * 3);
    }
    // follow camera
    if (this.followId) {
      const a = this.agents.get(this.followId);
      if (a) this.target.lerp(new THREE.Vector3(a.gx, 0, a.gy), 0.1);
    }
    this.cam.zoom = this.zoom;
    this.cam.updateProjectionMatrix();
    const dist = 60;
    this.cam.position.copy(this.target).addScaledVector(ISO_DIR, dist);
    this.cam.lookAt(this.target);

    // billboards face the camera (its orientation is constant, only pans)
    for (const b of this.billboards) if (b.visible) b.quaternion.copy(this.cam.quaternion);

    this.onFrame?.();
    this.renderer.render(this.scene, this.cam);
  }

  onFrame?: () => void;
}

const FACE: Record<string, [number, number]> = {
  n: [0, -1],
  s: [0, 1],
  e: [1, 0],
  w: [-1, 0],
};

const EVIDENCE_TEX: Record<string, string | undefined> = {
  crt: '/sprites/generated/crt.png',
  printer: '/sprites/generated/printer.png',
  crate: '/sprites/generated/cans.png',
  sign: '/sprites/generated/sign_exit.png',
  corpse: '/sprites/generated/corpse.png',
  printout: '/sprites/generated/note.png',
  note: undefined,
  graffiti: undefined,
  anomaly: '/sprites/generated/crt.png',
};
