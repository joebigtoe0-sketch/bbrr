import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CHUNK_SIZE, EDGE, TILE, chunkKey } from '@backrooms/shared';
import type { Agent, EvidenceArtifact, MazeChunk } from '@backrooms/shared';
import { WorldStore } from '../state/worldStore.js';
import { Connection } from '../net/connection.js';
import { WALL_H, WALL_T, ISO_DIR } from './iso.js';

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
  root: THREE.Group; // holds the character model
  model?: THREE.Object3D;
  mixer?: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  current: string;
  idleName: string;
  hand?: THREE.Object3D;
  spot: THREE.SpotLight;
  target: THREE.Object3D;
  gx: number;
  gy: number;
  tx: number;
  ty: number;
  facing: string;
  battery: number;
  state: string;
  speed: number;
  danceUntil: number;
  nextDanceCheck: number;
  queue: { x: number; y: number }[];
}

function strHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0);
}

const IDLES = ['Idle_3', 'Idle_9'];
const DANCES = ['Bass_Beats', 'Boom_Dance'];
/** the model's forward is +Z (south); rotate to face the agent's heading */
const FACE_ROT: Record<string, number> = {
  s: 0,
  n: Math.PI,
  e: Math.PI / 2,
  w: -Math.PI / 2,
};

const VIEW_SIZE = 14; // world units visible vertically at zoom 1
/** internal render resolution as a fraction of screen — lower = chunkier + faster */
const RENDER_SCALE = 0.5;

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
  private monster = new THREE.Group();
  private chaos = new THREE.Group();
  private chaosModel?: THREE.Object3D;
  private chaosMixer?: THREE.AnimationMixer;
  private chaosMats: THREE.MeshStandardMaterial[] = [];
  private chaosPhase = 0;

  private floorTex!: THREE.Texture;
  private wallMat!: THREE.MeshStandardMaterial;
  private texCache = new Map<string, THREE.Texture>();
  private raycaster = new THREE.Raycaster();
  private billboards = new Set<THREE.Mesh>();
  private npcTemplate?: THREE.Object3D;
  private npcClips: THREE.AnimationClip[] = [];
  private lastFrameT = 0;
  private monsterModel?: THREE.Object3D;
  private monsterLegs: THREE.Object3D[] = [];
  private monsterLegRest: number[] = [];
  private monsterGX = 0;
  private monsterGY = 0;
  private monsterPhase = 0;
  private frameCount = 0;
  // ---- audio ----
  private listener?: THREE.AudioListener;
  private audioBuffers = new Map<string, AudioBuffer>();
  private ambientAudio?: THREE.Audio;
  private footstepAudio?: THREE.Audio;
  private monsterAudio?: THREE.Audio;
  private bgVol = 0.5;
  private sfxVol = 0.7;
  private audioStarted = false;
  private beepTimer?: number;
  private monsterNear = false;

  constructor(private container: HTMLElement) {
    // Render at a fraction of native resolution and upscale with nearest-neighbour:
    // big perf win (a quarter of the fragments) and the chunky, pixel-art backrooms
    // look of the original idea. No AA + cheaper shadows for the same reasons.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(RENDER_SCALE);
    this.renderer.domElement.style.imageRendering = 'pixelated';
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
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
    this.monster.visible = false;
    this.scene.add(this.monster);
    this.chaos.visible = false;
    this.scene.add(this.chaos);

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.loadNpcModel();
    this.loadMonsterModel();
    this.initAudio();
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
        this.scene.remove(a.root, a.spot, a.target);
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
        this.scene.remove(a.root, a.spot, a.target);
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
    // tile (gx,gy) occupies the square [gx,gx+1]x[gy,gy+1] (centre gx+0.5,gy+0.5)
    // — the same convention the server uses for agents/monster and that evidence
    // renders with (+0.5). Getting this wrong put entities half a tile into walls.
    floor.position.set(ox + S / 2, 0, oy + S / 2);
    floor.receiveShadow = true;
    group.add(floor);

    // walls: merge all edge boxes into one shadow-casting mesh
    const boxes: THREE.BufferGeometry[] = [];
    for (let ly = 0; ly < S; ly++) {
      for (let lx = 0; lx < S; lx++) {
        const i = ly * S + lx;
        const gx = ox + lx;
        const gy = oy + ly;
        // Each segment is over-length by WALL_T (0.1 past each end) so that at an
        // L-corner the perpendicular walls OVERLAP and seal the little outer-corner
        // gap — otherwise the flashlight shines diagonally through it as a bright
        // stripe (the real "shadow leak"). Walls also extend below the floor so the
        // shadow's contact line is buried (no lit sliver under a wall).
        const eh = c.wallsH[i]!;
        if (eh === EDGE.Wall || eh === EDGE.DoorLocked) {
          // north edge of tile (its y=gy side), running along x across the tile
          const g = new THREE.BoxGeometry(1 + WALL_T, WALL_H + 0.3, WALL_T);
          g.translate(gx + 0.5, WALL_H / 2, gy);
          boxes.push(g);
        }
        const ev = c.wallsV[i]!;
        if (ev === EDGE.Wall || ev === EDGE.DoorLocked) {
          // west edge of tile (its x=gx side), running along z across the tile
          const g = new THREE.BoxGeometry(WALL_T, WALL_H + 0.3, 1 + WALL_T);
          g.translate(gx, WALL_H / 2, gy + 0.5);
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
          light.position.set(gx + 0.5, WALL_H - 0.1, gy + 0.5);
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

  // ---------------- audio ----------------

  private initAudio() {
    this.listener = new THREE.AudioListener();
    // the ortho camera sits ~60 units back, so a camera-parented listener would
    // hear every terminal as "far". Put the listener in the scene at the followed
    // agent instead (moved each frame), so spatial falloff is measured from them.
    this.scene.add(this.listener);
    const loader = new THREE.AudioLoader();
    this.ambientAudio = new THREE.Audio(this.listener);
    this.footstepAudio = new THREE.Audio(this.listener);
    this.monsterAudio = new THREE.Audio(this.listener);
    loader.load('/audio/backgroundambienthumm.mp3', (buf) => {
      this.ambientAudio!.setBuffer(buf);
      this.ambientAudio!.setLoop(true);
      this.ambientAudio!.setVolume(this.bgVol * 0.5);
      if (this.audioStarted && !this.ambientAudio!.isPlaying) this.ambientAudio!.play();
    });
    loader.load('/audio/footsteps.mp3', (buf) => {
      this.footstepAudio!.setBuffer(buf);
      this.footstepAudio!.setLoop(true);
      this.footstepAudio!.setVolume(0); // modulated per-frame by the followed agent
      if (this.audioStarted && !this.footstepAudio!.isPlaying) this.footstepAudio!.play();
    });
    loader.load('/audio/monsterclose.mp3', (buf) => {
      this.monsterAudio!.setBuffer(buf);
      this.monsterAudio!.setLoop(false);
      this.monsterAudio!.setVolume(this.sfxVol);
    });
    loader.load('/audio/terminalbeeps.mp3', (buf) => this.audioBuffers.set('beep', buf));
    // any gesture anywhere (incl. the volume sliders) unlocks Web Audio
    window.addEventListener('pointerdown', () => this.resumeAudio());
    window.addEventListener('keydown', () => this.resumeAudio());
  }

  /** Web Audio needs a user gesture; call this from the first pointer input. */
  private resumeAudio() {
    if (this.audioStarted) return;
    this.audioStarted = true;
    void this.listener?.context.resume();
    if (this.ambientAudio?.buffer && !this.ambientAudio.isPlaying) this.ambientAudio.play();
    if (this.footstepAudio?.buffer && !this.footstepAudio.isPlaying) this.footstepAudio.play();
    this.beepTimer = window.setInterval(() => this.beepTerminals(), 5000);
  }

  /** every terminal chirps; the positional falloff means you only HEAR the near ones */
  private beepTerminals() {
    const beep = this.audioBuffers.get('beep');
    if (!beep) return;
    for (const obj of this.evidence.values()) {
      const pa = obj.userData.beaconAudio as THREE.PositionalAudio | undefined;
      if (!pa) continue;
      if (!pa.buffer) pa.setBuffer(beep);
      if (pa.isPlaying) pa.stop();
      pa.play();
    }
  }

  setBgVol(v: number) {
    this.bgVol = Math.max(0, Math.min(1, v));
    this.ambientAudio?.setVolume(this.bgVol * 0.5);
  }
  setSfxVol(v: number) {
    this.sfxVol = Math.max(0, Math.min(1, v));
    this.monsterAudio?.setVolume(this.sfxVol);
    for (const obj of this.evidence.values()) {
      (obj.userData.beaconAudio as THREE.PositionalAudio | undefined)?.setVolume(this.sfxVol);
    }
  }

  private disposeChunkMesh(key: string) {
    const cm = this.chunkMeshes.get(key);
    if (!cm) return;
    for (const l of cm.lights) this.scene.remove(l);
    this.scene.remove(cm.group);
    cm.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.chunkMeshes.delete(key);
  }

  /**
   * Keep only the chunks near the followed agent loaded. Everything far is pitch
   * black in the backrooms anyway, so dropping it costs nothing visually but keeps
   * draw calls, geometry and lights bounded no matter how far the agent roams —
   * this is what makes it run on any machine. Dropped chunks re-fetch on return.
   */
  private evictFarChunks(centerX: number, centerY: number) {
    const ccx = Math.floor(centerX / CHUNK_SIZE);
    const ccy = Math.floor(centerY / CHUNK_SIZE);
    const KEEP = 2; // chunks of Chebyshev radius to retain
    for (const key of [...this.chunkMeshes.keys()]) {
      const [kx, ky] = key.split(',').map(Number);
      if (Math.max(Math.abs(kx! - ccx), Math.abs(ky! - ccy)) > KEEP) {
        this.disposeChunkMesh(key);
        this.store.dropChunk(key);
      }
    }
  }

  // ---------------- entities ----------------

  private upsertAgent(a: Agent) {
    let o = this.agents.get(a.id);
    if (!o) {
      const root = new THREE.Group();
      root.position.set(a.x, 0, a.y);
      this.scene.add(root);
      const spot = new THREE.SpotLight(0xffe4ad, 155, 15, Math.PI / 6, 0.6, 1.1);
      spot.castShadow = false;
      // high-res shadow map + normalBias so thin(ish) walls fully occlude the
      // beam instead of letting it bleed past their edges when aimed down a hall
      spot.shadow.mapSize.set(1024, 1024);
      spot.shadow.camera.near = 0.1;
      spot.shadow.camera.far = 18;
      // small biases: too much normalBias detaches the shadow from the wall
      // (peter-panning — a lit gap appears right behind the wall)
      spot.shadow.bias = -0.0004;
      spot.shadow.normalBias = 0.004;
      const target = new THREE.Object3D();
      this.scene.add(spot, target);
      spot.target = target;
      o = {
        root,
        actions: new Map(),
        current: '',
        idleName: IDLES[strHash(a.id) % IDLES.length]!,
        spot,
        target,
        gx: a.x,
        gy: a.y,
        tx: a.x,
        ty: a.y,
        facing: a.facing,
        battery: a.battery,
        state: a.state,
        speed: 0,
        danceUntil: 0,
        nextDanceCheck: 0,
        queue: [],
      };
      this.agents.set(a.id, o);
      if (this.npcTemplate) this.buildAgentModel(o, a.hue);
    }
    o.tx = a.x;
    o.ty = a.y;
    o.facing = a.facing;
    o.battery = a.battery;
    o.state = a.state;
    const last = o.queue[o.queue.length - 1];
    if (!last || Math.abs(last.x - a.x) > 0.001 || Math.abs(last.y - a.y) > 0.001) {
      o.queue.push({ x: a.x, y: a.y });
    }
    if (a.state === 'dead' && o.model) o.model.visible = true;
  }

  private loadNpcModel() {
    new GLTFLoader().load('/sprites/generated/npc.glb', (gltf) => {
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const size = new THREE.Vector3();
      box.getSize(size);
      const s = 1.5 / (size.y || 1.8);
      gltf.scene.scale.setScalar(s);
      gltf.scene.position.y = -box.min.y * s;
      this.npcTemplate = gltf.scene;
      this.npcClips = gltf.animations;
      // build models for agents that arrived before the mesh loaded — with their
      // REAL hue (passing 0 here made the whole first batch identical)
      for (const [id, o] of this.agents) {
        if (!o.model) this.buildAgentModel(o, this.store.agents.get(id)?.hue ?? 0);
      }
      this.buildChaosModel();
    });
  }

  /** the chaos: an npc-shaped body, but glitching and see-through (a wrong thing) */
  private buildChaosModel() {
    if (!this.npcTemplate || this.chaosModel) return;
    const model = skeletonClone(this.npcTemplate);
    this.chaosMats = [];
    model.traverse((n) => {
      const m = n as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = false;
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        mat.transparent = true;
        mat.opacity = 0.5;
        mat.color.setHex(0x8a2f90);
        mat.emissive = new THREE.Color(0xd026c9);
        mat.emissiveIntensity = 0.6;
        mat.depthWrite = false;
        m.material = mat;
        this.chaosMats.push(mat);
      }
    });
    this.chaos.add(model);
    this.chaosModel = model;
    this.chaosMixer = new THREE.AnimationMixer(model);
    const idle = this.npcClips.find((c) => c.name === IDLES[0]) ?? this.npcClips[0];
    if (idle) this.chaosMixer.clipAction(idle).play();
  }

  private loadMonsterModel() {
    new GLTFLoader().load('/sprites/generated/monster.glb', (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      box.getSize(size);
      const s = 2.5 / (size.y || 2);
      model.scale.setScalar(s);
      model.position.y = -box.min.y * s;
      model.traverse((n) => {
        const m = n as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          const mat = (m.material as THREE.MeshStandardMaterial).clone();
          mat.color.multiplyScalar(0.35); // a dark thing that only shows when lit
          mat.emissive = new THREE.Color(0x000000);
          mat.roughness = 1;
          m.material = mat;
        }
      });
      // heuristic 'legs': the lowest few bones get a stepping wobble
      model.updateMatrixWorld(true);
      const bones: { b: THREE.Object3D; y: number }[] = [];
      const v = new THREE.Vector3();
      model.traverse((n) => {
        if ((n as THREE.Bone).isBone) {
          n.getWorldPosition(v);
          bones.push({ b: n, y: v.y });
        }
      });
      bones.sort((a, b) => a.y - b.y);
      this.monsterLegs = bones.slice(0, 6).map((x) => x.b);
      this.monsterLegRest = this.monsterLegs.map((b) => b.rotation.x);
      this.monster.add(model);
      this.monsterModel = model;

      // two red eyes + a faint red glow, so it's barely visible in the dark.
      // MeshBasic = self-lit (always red); the glow lets it bleed into the black.
      const sz = size.clone().multiplyScalar(s);
      const eyeY = sz.y * 0.82;
      const eyeZ = sz.z * 0.32;
      const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff1515 });
      const eyeGeo = new THREE.SphereGeometry(0.07, 8, 8);
      for (const ex of [-sz.x * 0.14, sz.x * 0.14]) {
        const eye = new THREE.Mesh(eyeGeo, eyeMat);
        eye.position.set(ex, eyeY, eyeZ);
        this.monster.add(eye);
      }
      const eyeGlow = new THREE.PointLight(0xff1a1a, 2.4, 3.4, 1.6);
      eyeGlow.position.set(0, eyeY, eyeZ * 0.7);
      this.monster.add(eyeGlow);
    });
  }

  private buildAgentModel(o: AgentObj, hue: number) {
    if (!this.npcTemplate) return;
    const model = skeletonClone(this.npcTemplate);
    const tint = new THREE.Color().setHSL(((((hue % 360) + 360) % 360) / 360), 0.8, 0.6);
    model.traverse((n) => {
      const m = n as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        mat.color.multiply(tint);
        // a faint self-colour so each agent stays their own hue even in the dark
        // (the warm flashlight otherwise washes everyone to the same grey)
        mat.emissive = tint.clone();
        mat.emissiveIntensity = 0.22;
        m.material = mat;
      }
    });
    // (no held-flashlight prop — the beam itself sells it; the mesh looked odd)
    o.root.add(model);
    o.model = model;
    const mixer = new THREE.AnimationMixer(model);
    o.mixer = mixer;
    for (const clip of this.npcClips) o.actions.set(clip.name, mixer.clipAction(clip));
    this.playAnim(o, o.idleName);
  }

  private playAnim(o: AgentObj, name: string) {
    if (o.current === name || !o.actions.has(name)) return;
    const next = o.actions.get(name)!;
    const prev = o.current ? o.actions.get(o.current) : undefined;
    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    // death plays once and holds on the last frame (a body, not a loop)
    if (name === 'Dead') {
      next.setLoop(THREE.LoopOnce, 1);
      next.clampWhenFinished = true;
    } else {
      next.setLoop(THREE.LoopRepeat, Infinity);
      next.clampWhenFinished = false;
    }
    next.fadeIn(0.25);
    next.play();
    if (prev) prev.fadeOut(0.25);
    o.current = name;
  }

  private updateMonster() {
    this.monster.visible = true;
  }
  private updateChaos() {
    const c = this.store.chaos;
    this.chaos.visible = c.visible;
    if (c.visible) this.chaos.position.set(c.x, 0, c.y);
  }

  private upsertEvidence(e: EvidenceArtifact) {
    const existing = this.evidence.get(e.id);
    if (existing) this.scene.remove(existing);
    let obj: THREE.Object3D;
    if (e.kind === 'note' || e.kind === 'printout') {
      // a paper scrap lying on the floor
      const geo = new THREE.PlaneGeometry(0.45, 0.55);
      geo.rotateX(-Math.PI / 2);
      geo.rotateY((e.id.charCodeAt(0) % 8) * 0.3);
      obj = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ map: this.tex('/sprites/generated/note.png'), transparent: true, alphaTest: 0.3, roughness: 1 }),
      );
    } else if (e.kind === 'graffiti') {
      // a small spray splash on the floor
      const geo = new THREE.PlaneGeometry(0.55, 0.55);
      geo.rotateX(-Math.PI / 2);
      obj = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color: 0xc23b2e, roughness: 1, transparent: true, opacity: 0.85 }),
      );
    } else {
      const url = EVIDENCE_TEX[e.kind];
      const isTerminal = e.kind === 'crt' || e.kind === 'anomaly';
      obj = this.makeBillboard(this.tex(url ?? '/sprites/generated/note.png'), 0.7, 0.9, {
        emissive: isTerminal ? 0x14aa33 : 0,
      });
      if (isTerminal) {
        // a flashing green pilot light so terminals are findable in the dark
        const glow = new THREE.PointLight(0x33ff66, 3, 4.5, 1.4);
        glow.position.set(0, 0.55, 0);
        obj.add(glow);
        obj.userData.beaconLight = glow;
        obj.userData.beaconMat = (obj as THREE.Mesh).material;
        obj.userData.beaconPhase = Math.random() * 6.28;
        // spatial beep — only audible when the camera (listener) is near it
        if (this.listener) {
          const pa = new THREE.PositionalAudio(this.listener);
          pa.setRefDistance(3);
          pa.setMaxDistance(13);
          pa.setRolloffFactor(1.4);
          pa.setDistanceModel('linear');
          pa.setVolume(this.sfxVol);
          const beep = this.audioBuffers.get('beep');
          if (beep) pa.setBuffer(beep);
          obj.add(pa);
          obj.userData.beaconAudio = pa;
        }
      }
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
      this.resumeAudio(); // first gesture unlocks Web Audio
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
      moved += Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly);
      lx = e.clientX;
      ly = e.clientY;
      // camera is locked to the followed agent — no manual panning
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
    // agents first (tune-in) — mark each agent's root with its id and raycast
    const roots: THREE.Object3D[] = [];
    for (const [id, o] of this.agents) {
      o.root.traverse((n) => (n.userData.agentId = id));
      roots.push(o.root);
    }
    const hitA = this.raycaster.intersectObjects(roots, true)[0];
    if (hitA) {
      let n: THREE.Object3D | null = hitA.object;
      while (n && !n.userData.agentId) n = n.parent;
      if (n) { this.onTuneIn?.(n.userData.agentId as string); return; }
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
    const dt = this.lastFrameT ? Math.min(0.05, (_t - this.lastFrameT) / 1000) : 0.016;
    this.lastFrameT = _t;
    const nowMs = performance.now();
    for (const o of this.agents.values()) {
      // smooth constant-speed movement along the server-position trail
      const px = o.gx;
      const py = o.gy;
      let budget = 1.75 * dt;
      if (o.queue.length > 3) budget *= 1 + (o.queue.length - 3) * 0.5;
      while (budget > 0 && o.queue.length > 0) {
        const t = o.queue[0]!;
        const d = Math.hypot(t.x - o.gx, t.y - o.gy);
        if (d > 4) { o.gx = t.x; o.gy = t.y; o.queue.shift(); continue; }
        if (d <= budget) { o.gx = t.x; o.gy = t.y; budget -= d; o.queue.shift(); }
        else { o.gx += ((t.x - o.gx) / d) * budget; o.gy += ((t.y - o.gy) / d) * budget; budget = 0; }
      }
      const inst = Math.hypot(o.gx - px, o.gy - py) / (dt || 0.016);
      o.speed += (inst - o.speed) * 0.25;
      // only the followed agent casts flashlight shadows (keeps the framerate up)
      const followed = o === this.agents.get(this.followId ?? '');
      if (o.spot.castShadow !== followed) o.spot.castShadow = followed;
      o.root.position.set(o.gx, 0, o.gy);
      const wantRot = FACE_ROT[o.facing] ?? 0;
      let dr = wantRot - o.root.rotation.y;
      while (dr > Math.PI) dr -= Math.PI * 2;
      while (dr < -Math.PI) dr += Math.PI * 2;
      o.root.rotation.y += dr * Math.min(1, dt * 10);
      // drive the walk cycle off ACTUAL motion, not the server 'moving' flag —
      // that flag can stick, leaving an agent 'walking' on the spot
      const movingNow = o.queue.length > 0 || o.speed > 0.4;
      let anim: string;
      if (o.state === 'dead') anim = 'Dead';
      else if (movingNow && o.speed > 1.75) anim = 'Running';
      else if (movingNow) anim = 'Walking';
      else {
        if (nowMs > o.nextDanceCheck) {
          o.nextDanceCheck = nowMs + 12000;
          if (Math.random() < 0.22) o.danceUntil = nowMs + 6500;
        }
        anim = o.danceUntil > nowMs ? DANCES[strHash(o.root.uuid) % DANCES.length]! : o.idleName;
      }
      this.playAnim(o, anim);
      o.mixer?.update(dt);
      const bf = o.battery <= 0 ? 0.3 : 0.45 + 0.55 * (o.battery / 100);
      const fd = FACE[o.facing] ?? [0, 1];
      // anchor the beam to the BODY CENTRE (always >=0.5 tiles from any wall),
      // nudged a little forward — never the hand's swinging world position, which
      // could cross to the far side of a thin wall when the agent hugs it. Kept
      // LOW (below the wall tops) so the cone can't skim over walls into the next
      // room; the shadow map then contains it to the corridor the agent is in.
      o.spot.position.set(o.gx + fd[0] * 0.18, 0.92, o.gy + fd[1] * 0.18);
      // the followed agent (whose light is shadow-contained) gets the big reach;
      // others get a short, dim beam so their un-shadowed light barely leaks
      const reach = followed ? 15 : 6.5;
      o.spot.intensity = (followed ? 175 : 100) * bf;
      o.spot.distance = reach * bf;
      // aim a bit closer/lower so the beam axis tilts down — keeps the cone's
      // upper edge from rising over wall tops
      o.target.position.set(o.gx + fd[0] * 2.4, 0.04, o.gy + fd[1] * 2.4);
    }
    // ---- monster: smooth move + procedural creature animation ----
    {
      const m = this.store.monster;
      const dx = m.x - this.monsterGX;
      const dy = m.y - this.monsterGY;
      const step = Math.hypot(dx, dy);
      this.monsterGX += dx * Math.min(1, dt * 6);
      this.monsterGY += dy * Math.min(1, dt * 6);
      this.monster.position.set(this.monsterGX, 0, this.monsterGY);
      const moving = step > 0.02;
      if (step > 0.001) {
        const want = Math.atan2(dx, dy);
        let dr = want - this.monster.rotation.y;
        while (dr > Math.PI) dr -= Math.PI * 2;
        while (dr < -Math.PI) dr += Math.PI * 2;
        this.monster.rotation.y += dr * Math.min(1, dt * 6);
      }
      this.monsterPhase += dt * (moving ? 8 : 2.5);
      if (this.monsterModel) {
        this.monsterModel.position.y = Math.abs(Math.sin(this.monsterPhase)) * (moving ? 0.14 : 0.05);
        this.monsterModel.rotation.z = Math.sin(this.monsterPhase * 0.5) * 0.05;
        const amp = moving ? 0.35 : 0.08;
        for (let i = 0; i < this.monsterLegs.length; i++) {
          this.monsterLegs[i]!.rotation.x =
            this.monsterLegRest[i]! + Math.sin(this.monsterPhase + i * Math.PI) * amp;
        }
      }
    }

    // ---- terminal beacons: pulse the green glow; but only the few NEAREST
    // terminals get a real point light (lots of live lights was causing lag).
    // The emissive flash is free and stays on for all of them.
    const beacons: { obj: THREE.Object3D; d: number }[] = [];
    for (const obj of this.evidence.values()) {
      const glow = obj.userData.beaconLight as THREE.PointLight | undefined;
      if (!glow) continue;
      const ph = obj.userData.beaconPhase as number;
      const blink = 0.35 + 0.65 * Math.pow(Math.max(0, Math.sin(nowMs * 0.004 + ph)), 3);
      const mat = obj.userData.beaconMat as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 0.4 + 1.4 * blink;
      glow.userData.blink = blink;
      beacons.push({ obj, d: (obj.position.x - this.target.x) ** 2 + (obj.position.z - this.target.z) ** 2 });
    }
    beacons.sort((a, b) => a.d - b.d);
    for (let i = 0; i < beacons.length; i++) {
      const glow = beacons[i]!.obj.userData.beaconLight as THREE.PointLight;
      const near = i < 3;
      glow.visible = near;
      if (near) glow.intensity = 1.2 + 5 * (glow.userData.blink as number);
    }

    // ---- chaos: glitching, see-through body ----
    if (this.chaos.visible && this.chaosModel) {
      this.chaosMixer?.update(dt);
      this.chaosPhase += dt;
      // datamosh jitter: snap-offset the body and flicker its opacity
      const jitter = Math.random() < 0.35;
      this.chaosModel.position.x = jitter ? (Math.random() - 0.5) * 0.18 : 0;
      this.chaosModel.position.z = jitter ? (Math.random() - 0.5) * 0.18 : 0;
      this.chaosModel.scale.y = jitter ? 1 + (Math.random() - 0.5) * 0.25 : 1;
      const op = 0.32 + 0.28 * Math.abs(Math.sin(this.chaosPhase * 7)) + (jitter ? 0.15 : 0);
      for (const m of this.chaosMats) m.opacity = Math.min(0.7, op);
      this.chaos.rotation.y += dt * 0.6; // slowly turns, never settling
    }

    // ---- audio: footsteps of the followed agent + monster-proximity sting ----
    if (this.audioStarted) {
      const fo = this.agents.get(this.followId ?? '');
      // keep the listener on the agent we're watching (drives terminal falloff)
      if (this.listener) this.listener.position.set(this.target.x, 0.8, this.target.z);
      if (this.footstepAudio?.buffer) {
        const moving = !!fo && fo.state !== 'dead' && (fo.state === 'moving' || fo.queue.length > 0 || fo.speed > 0.25);
        if (moving) {
          this.footstepAudio.setPlaybackRate(fo!.speed > 1.75 ? 1.7 : 1.05); // faster when running
          this.footstepAudio.setVolume(this.sfxVol * 0.55);
        } else {
          this.footstepAudio.setVolume(0);
        }
      }
      if (this.monsterAudio?.buffer && fo) {
        const d = Math.hypot(this.monsterGX - fo.gx, this.monsterGY - fo.gy);
        if (d < 8 && !this.monsterNear) {
          this.monsterNear = true; // fires once as it closes in
          if (this.monsterAudio.isPlaying) this.monsterAudio.stop();
          this.monsterAudio.setVolume(this.sfxVol);
          this.monsterAudio.play();
        } else if (d > 13) {
          this.monsterNear = false;
        }
      }
    }

    // camera is always locked to an agent; default to the first if none chosen
    if (!this.followId || !this.agents.has(this.followId)) {
      const first = [...this.agents.keys()][0];
      if (first) this.followId = first;
    }
    if (this.followId) {
      const a = this.agents.get(this.followId);
      if (a) this.target.lerp(new THREE.Vector3(a.gx, 0, a.gy), 0.12);
    }
    // keep only nearby chunks resident (bounded memory / draw calls)
    if ((this.frameCount++ & 31) === 0) this.evictFarChunks(this.target.x, this.target.z);
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
