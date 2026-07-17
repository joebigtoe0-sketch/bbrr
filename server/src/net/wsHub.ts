import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { ClientMsg, PROTOCOL_VERSION, chunkKey } from '@backrooms/shared';
import type { MazeChunk, EvidenceArtifact, ServerMsg } from '@backrooms/shared';
import type { World } from '../sim/world.js';
import { toWireMonster } from '../sim/monster.js';
import { chunkRepo, evidenceRepo } from '../db/repo.js';

interface Client {
  ws: WebSocket;
  subscribed: Set<string>;
  tunedAgentId: string | null;
}

export class WsHub {
  private clients = new Set<Client>();
  readonly wss: WebSocketServer;

  constructor(
    server: Server,
    private world: World,
  ) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws) => this.onConnection(ws));

    world.subscriptionAnchors = () => {
      const anchors: { cx: number; cy: number }[] = [];
      for (const c of this.clients) {
        for (const key of c.subscribed) {
          const [cx, cy] = key.split(',').map(Number);
          anchors.push({ cx: cx!, cy: cy! });
        }
      }
      return anchors;
    };

    world.onThought = (thought) => {
      const msg = JSON.stringify({ t: 'thought', thought } satisfies ServerMsg);
      for (const c of this.clients) {
        if (c.tunedAgentId === thought.agentId && c.ws.readyState === WebSocket.OPEN) {
          c.ws.send(msg);
        }
      }
    };

    world.afterTick = () => {
      const delta = this.world.buildDelta();
      if (!delta || this.clients.size === 0) return;
      const msg = JSON.stringify({ t: 'delta', ...delta } satisfies ServerMsg);
      for (const c of this.clients) {
        if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
      }
    };
  }

  private send(c: Client, msg: ServerMsg) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  }

  private onConnection(ws: WebSocket) {
    const client: Client = { ws, subscribed: new Set(), tunedAgentId: null };
    this.clients.add(client);
    this.world.spectatorCount = this.clients.size;

    this.send(client, {
      t: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      tick: this.world.tick,
      worldSeed: this.world.seed,
    });
    this.send(client, {
      t: 'snapshot',
      tick: this.world.tick,
      agents: this.world.snapshotAgents(),
      monster: toWireMonster(this.world.monsterRt),
      chaos: {
        x: this.world.chaosRt.x,
        y: this.world.chaosRt.y,
        visible: this.world.chaosRt.visible,
      },
    });

    ws.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      const result = ClientMsg.safeParse(parsed);
      if (!result.success) return;
      this.handle(client, result.data);
    });

    ws.on('close', () => {
      this.clients.delete(client);
      this.world.spectatorCount = this.clients.size;
    });
    ws.on('error', () => {
      this.clients.delete(client);
      this.world.spectatorCount = this.clients.size;
    });
  }

  private handle(client: Client, msg: ClientMsg) {
    switch (msg.t) {
      case 'subscribe_chunks': {
        const wanted = new Set(msg.coords.map((c) => chunkKey(c.cx, c.cy)));
        const fresh: MazeChunk[] = [];
        const evidence: EvidenceArtifact[] = [];
        for (const c of msg.coords) {
          const key = chunkKey(c.cx, c.cy);
          if (client.subscribed.has(key)) continue;
          // spectators never generate the world: send only chunks that exist
          let chunk = this.world.maze.getLoaded(key);
          if (!chunk) {
            if (!chunkRepo.get(key)) continue;
            chunk = this.world.maze.ensureChunk(c.cx, c.cy); // loads from DB, no gen
          }
          fresh.push(this.world.maze.toWire(chunk));
          evidence.push(...evidenceRepo.byChunk(key));
        }
        client.subscribed = wanted;
        if (fresh.length > 0) this.send(client, { t: 'chunks', chunks: fresh, evidence });
        break;
      }
      case 'tune_in':
        client.tunedAgentId = msg.agentId;
        break;
      case 'tune_out':
        client.tunedAgentId = null;
        break;
      case 'ping':
        this.send(client, { t: 'pong', tick: this.world.tick });
        break;
    }
  }
}
