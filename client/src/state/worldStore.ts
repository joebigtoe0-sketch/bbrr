import { chunkKey } from '@backrooms/shared';
import type {
  Agent,
  EvidenceArtifact,
  MazeChunk,
  MonsterState,
  ServerMsg,
  ThoughtEvent,
  WorldEvent,
} from '@backrooms/shared';

export interface ChaosView {
  x: number;
  y: number;
  visible: boolean;
}

/** Client mirror of server state; the scene subscribes to change callbacks. */
export class WorldStore {
  tick = 0;
  agents = new Map<string, Agent>();
  monster: MonsterState = { x: 0, y: 0, mode: 'roam' };
  chaos: ChaosView = { x: 0, y: 0, visible: false };
  chunks = new Map<string, MazeChunk>();
  evidence = new Map<string, EvidenceArtifact>();

  onSnapshot: () => void = () => {};
  onChunk: (c: MazeChunk) => void = () => {};
  onChunkChanged: (key: string) => void = () => {};
  onAgent: (a: Agent) => void = () => {};
  onAgentRemove: (id: string) => void = () => {};
  onMonster: (m: MonsterState) => void = () => {};
  onChaos: (c: ChaosView) => void = () => {};
  onEvidence: (e: EvidenceArtifact, isNew: boolean) => void = () => {};
  onEvidenceRemove: (id: string) => void = () => {};
  onLight: (cx: number, cy: number, on: boolean) => void = () => {};
  onWorldEvent: (e: WorldEvent) => void = () => {};
  onSpeech: (agentId: string, text: string) => void = () => {};
  onThought: (t: ThoughtEvent) => void = () => {};

  dropChunk(key: string) {
    this.chunks.delete(key);
    for (const [id, e] of this.evidence) {
      const k = chunkKey(Math.floor(e.x / 16), Math.floor(e.y / 16));
      if (k === key) this.evidence.delete(id);
    }
  }

  apply(msg: ServerMsg) {
    switch (msg.t) {
      case 'hello':
        this.tick = msg.tick;
        break;
      case 'snapshot': {
        this.tick = msg.tick;
        this.agents.clear();
        for (const a of msg.agents) this.agents.set(a.id, a);
        this.monster = msg.monster;
        this.chaos = msg.chaos;
        this.onSnapshot();
        break;
      }
      case 'chunks': {
        for (const c of msg.chunks) {
          this.chunks.set(chunkKey(c.cx, c.cy), c);
          this.onChunk(c);
        }
        for (const e of msg.evidence) {
          const isNew = !this.evidence.has(e.id);
          this.evidence.set(e.id, e);
          this.onEvidence(e, isNew);
        }
        break;
      }
      case 'delta': {
        this.tick = msg.tick;
        for (const a of msg.agents) {
          this.agents.set(a.id, a);
          this.onAgent(a);
        }
        for (const id of msg.removedAgents) {
          this.agents.delete(id);
          this.onAgentRemove(id);
        }
        if (msg.monster) {
          this.monster = msg.monster;
          this.onMonster(msg.monster);
        }
        if (msg.chaos) {
          this.chaos = msg.chaos;
          this.onChaos(msg.chaos);
        }
        for (const e of msg.evidenceAdd) {
          this.evidence.set(e.id, e);
          this.onEvidence(e, true);
        }
        for (const e of msg.evidenceUpdate) {
          this.evidence.set(e.id, e);
          this.onEvidence(e, false);
        }
        for (const id of msg.evidenceRemove) {
          this.evidence.delete(id);
          this.onEvidenceRemove(id);
        }
        for (const tu of msg.tileUpdates) {
          const c = this.chunks.get(chunkKey(tu.cx, tu.cy));
          if (c) {
            c.tiles[tu.i] = tu.tile;
            this.onChunkChanged(chunkKey(tu.cx, tu.cy));
          }
        }
        for (const eu of msg.edgeUpdates) {
          const c = this.chunks.get(chunkKey(eu.cx, eu.cy));
          if (c) {
            (eu.dir === 'h' ? c.wallsH : c.wallsV)[eu.i] = eu.value;
            this.onChunkChanged(chunkKey(eu.cx, eu.cy));
          }
        }
        for (const lu of msg.lightUpdates) {
          const c = this.chunks.get(chunkKey(lu.cx, lu.cy));
          if (c) c.lightsOn = lu.on;
          this.onLight(lu.cx, lu.cy, lu.on);
        }
        for (const e of msg.worldEvents) this.onWorldEvent(e);
        for (const s of msg.speech) this.onSpeech(s.agentId, s.text);
        break;
      }
      case 'thought':
        this.onThought(msg.thought);
        break;
      case 'spawn_result':
      case 'pong':
        break;
    }
  }
}
