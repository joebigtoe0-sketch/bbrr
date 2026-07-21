import type { BrainDecision, Objective } from '@backrooms/shared';

/** Everything an agent knows at decision time. Coordinate-free by design. */
export interface Observation {
  name: string;
  objective: Objective;
  stress: number;
  stressWord: string;
  attentionWord: string;
  batteryWord: string;
  energyWord: string;
  aliveMinutes: number;
  locationLine: string; // "open room, lights flickering. Ways on: north (dark corridor), east (lit doorway)."
  visibleEvidence: string[]; // up to 5 human-readable lines
  nearbyAgents: { name: string; distance: number; lastSaid: string | null }[];
  monsterNearby: boolean;
  /** the thing is hunting THIS agent right now */
  beingChased: boolean;
  monsterDistance: number;
  heard: string[]; // things said to/near this agent since last decision
  memorySummary: string;
  memoryNotes: string[];
  lastActionResult: string;
  recentActions: string[];
  hasTerminalNearby: boolean;
  hasPrinterNearby: boolean;
  hasCrateNearby: boolean;
}

export interface Brain {
  readonly kind: 'mock' | 'openai';
  decide(obs: Observation): Promise<BrainDecision>;
}
