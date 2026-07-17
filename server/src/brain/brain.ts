import type { BrainDecision, Objective } from '@backrooms/shared';

/** Everything an agent knows at decision time. Coordinate-free by design. */
export interface Observation {
  name: string;
  objective: Objective;
  stress: number;
  stressWord: string;
  attentionWord: string;
  aliveMinutes: number;
  locationLine: string; // "open room, lights flickering. Ways on: north (dark corridor), east (lit doorway)."
  visibleEvidence: string[]; // up to 5 human-readable lines
  nearbyAgents: { name: string; distance: number; lastSaid: string | null }[];
  monsterNearby: boolean;
  heard: string[]; // things said to/near this agent since last decision
  memorySummary: string;
  memoryNotes: string[];
  lastActionResult: string;
  hasTerminalNearby: boolean;
  hasPrinterNearby: boolean;
  hasCrateNearby: boolean;
}

export interface Brain {
  readonly kind: 'mock' | 'openai';
  decide(obs: Observation): Promise<BrainDecision>;
}
