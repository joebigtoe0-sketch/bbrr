import { z } from 'zod';
import { OBJECTIVES } from './constants.js';

export const MindStateSchema = z.enum(['calm', 'stressed', 'panicked', 'deceptive']);
export type MindState = z.infer<typeof MindStateSchema>;

export const ObjectiveSchema = z.enum(OBJECTIVES);

export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  objective: ObjectiveSchema,
  x: z.number(),
  y: z.number(),
  facing: z.enum(['n', 'e', 's', 'w']),
  state: z.enum(['idle', 'moving', 'interacting', 'dead']),
  stress: z.number(),
  attention: z.number(),
  /** flashlight charge 0..100 - the beam dims as it dies */
  battery: z.number(),
  /** physical reserves 0..100 - exhausted agents slow down */
  energy: z.number(),
  mindState: MindStateSchema,
  hue: z.number(), // 0..359, stable per agent, for client tinting
});
export type Agent = z.infer<typeof AgentSchema>;

export const MonsterStateSchema = z.object({
  x: z.number(),
  y: z.number(),
  mode: z.enum(['roam', 'hunt', 'dormant']),
  targetAgentId: z.string().optional(),
});
export type MonsterState = z.infer<typeof MonsterStateSchema>;

export const EvidenceKindSchema = z.enum([
  'graffiti',
  'corpse',
  'printout',
  'terminal_log',
  'poster',
  'crate',
  'sign',
  'note',
  'printer',
  'crt',
  'anomaly',
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const EvidenceArtifactSchema = z.object({
  id: z.string(),
  kind: EvidenceKindSchema,
  x: z.number(),
  y: z.number(),
  text: z.string().optional(),
  authorAgentId: z.string().optional(),
  authorName: z.string().optional(),
  createdTick: z.number(),
  meta: z.record(z.unknown()).optional(),
});
export type EvidenceArtifact = z.infer<typeof EvidenceArtifactSchema>;

export const ThoughtEventSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  text: z.string(),
  mindState: MindStateSchema,
  actionLabel: z.string(),
  tick: z.number(),
});
export type ThoughtEvent = z.infer<typeof ThoughtEventSchema>;

export const WorldEventTypeSchema = z.enum([
  'viral_post',
  'buyback',
  'burn',
  'airdrop',
  'liquidity_up',
  'door_unlock',
  'lights_change',
  'corridor_collapse',
  'crate_drop',
  'map_expand',
  'agent_died',
  'agent_spawned',
  'hunt_started',
  'terminal_post',
  'maze_tweet',
]);
export type WorldEventType = z.infer<typeof WorldEventTypeSchema>;

export const WorldEventSchema = z.object({
  id: z.string(),
  type: WorldEventTypeSchema,
  payload: z.record(z.unknown()),
  tick: z.number(),
});
export type WorldEvent = z.infer<typeof WorldEventSchema>;

export const MazeChunkSchema = z.object({
  cx: z.number(),
  cy: z.number(),
  tiles: z.array(z.number()), // CHUNK_SIZE^2, row-major (floor/rubble)
  wallsH: z.array(z.number()), // north edge of each tile (EDGE values)
  wallsV: z.array(z.number()), // west edge of each tile (EDGE values)
  lightsOn: z.boolean(),
  version: z.number(),
});
export type MazeChunk = z.infer<typeof MazeChunkSchema>;
