import { z } from 'zod';
import {
  AgentSchema,
  EvidenceArtifactSchema,
  MazeChunkSchema,
  MonsterStateSchema,
  ThoughtEventSchema,
  WorldEventSchema,
  ObjectiveSchema,
} from './entities.js';

// ---------- Server -> Client ----------

export const HelloMsg = z.object({
  t: z.literal('hello'),
  protocolVersion: z.number(),
  tick: z.number(),
  worldSeed: z.string(),
});

export const SnapshotMsg = z.object({
  t: z.literal('snapshot'),
  tick: z.number(),
  agents: z.array(AgentSchema),
  monster: MonsterStateSchema,
  chaos: z.object({ x: z.number(), y: z.number(), visible: z.boolean() }),
});

export const ChunksMsg = z.object({
  t: z.literal('chunks'),
  chunks: z.array(MazeChunkSchema),
  evidence: z.array(EvidenceArtifactSchema),
});

export const TileUpdateSchema = z.object({
  cx: z.number(),
  cy: z.number(),
  i: z.number(), // index into chunk tiles array
  tile: z.number(),
});

export const DeltaMsg = z.object({
  t: z.literal('delta'),
  tick: z.number(),
  agents: z.array(AgentSchema), // changed agents only (full rows, they're small)
  removedAgents: z.array(z.string()),
  monster: MonsterStateSchema.optional(),
  chaos: z.object({ x: z.number(), y: z.number(), visible: z.boolean() }).optional(),
  evidenceAdd: z.array(EvidenceArtifactSchema),
  evidenceUpdate: z.array(EvidenceArtifactSchema),
  evidenceRemove: z.array(z.string()),
  tileUpdates: z.array(TileUpdateSchema),
  lightUpdates: z.array(z.object({ cx: z.number(), cy: z.number(), on: z.boolean() })),
  worldEvents: z.array(WorldEventSchema),
  speech: z.array(z.object({ agentId: z.string(), text: z.string() })),
});

export const ThoughtMsg = z.object({
  t: z.literal('thought'),
  thought: ThoughtEventSchema,
});

export const SpawnResultMsg = z.object({
  t: z.literal('spawn_result'),
  ok: z.boolean(),
  agentId: z.string().optional(),
  error: z.string().optional(),
});

export const PongMsg = z.object({ t: z.literal('pong'), tick: z.number() });

export const ServerMsg = z.discriminatedUnion('t', [
  HelloMsg,
  SnapshotMsg,
  ChunksMsg,
  DeltaMsg,
  ThoughtMsg,
  SpawnResultMsg,
  PongMsg,
]);
export type ServerMsg = z.infer<typeof ServerMsg>;

// ---------- Client -> Server ----------

export const SubscribeChunksMsg = z.object({
  t: z.literal('subscribe_chunks'),
  coords: z.array(z.object({ cx: z.number(), cy: z.number() })).max(400),
});

export const TuneInMsg = z.object({ t: z.literal('tune_in'), agentId: z.string() });
export const TuneOutMsg = z.object({ t: z.literal('tune_out') });
export const PingMsg = z.object({ t: z.literal('ping') });

export const ClientMsg = z.discriminatedUnion('t', [
  SubscribeChunksMsg,
  TuneInMsg,
  TuneOutMsg,
  PingMsg,
]);
export type ClientMsg = z.infer<typeof ClientMsg>;

// ---------- REST ----------

export const SpawnAgentBody = z.object({
  name: z.string().min(1).max(24).regex(/^[\w\- ]+$/).optional(),
  objective: ObjectiveSchema,
});
export type SpawnAgentBody = z.infer<typeof SpawnAgentBody>;

export const AdminEventBody = z.object({
  type: z.enum(['viral_post', 'buyback', 'burn', 'airdrop', 'liquidity_up']),
  payload: z
    .object({
      agentId: z.string().optional(),
      magnitude: z.number().min(1).max(100).optional(),
      radiusChunks: z.number().min(1).max(8).optional(),
      count: z.number().min(1).max(10).optional(),
    })
    .default({}),
});
export type AdminEventBody = z.infer<typeof AdminEventBody>;

export const AdminDebugBody = z.object({
  action: z.enum(['teleport_monster', 'force_stress', 'force_deceiving']),
  x: z.number().optional(),
  y: z.number().optional(),
  agentId: z.string().optional(),
  value: z.number().optional(),
});
export type AdminDebugBody = z.infer<typeof AdminDebugBody>;
