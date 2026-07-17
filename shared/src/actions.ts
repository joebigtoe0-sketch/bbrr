import { z } from 'zod';

/**
 * The LLM's output contract. Actions are semantic and coordinate-free —
 * the server resolves targets like 'toward_unexplored' with pathfinding.
 */
export const AgentActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('move'),
    target: z.enum([
      'north',
      'south',
      'east',
      'west',
      'toward_unexplored',
      'toward_light',
      'toward_agent',
    ]),
    agentName: z.string().optional(),
  }),
  z.object({ type: z.literal('write_graffiti'), text: z.string().max(120) }),
  z.object({ type: z.literal('use_terminal'), text: z.string().max(280) }),
  z.object({ type: z.literal('print_note'), text: z.string().max(280) }),
  z.object({
    type: z.literal('say'),
    toAgentName: z.string().optional(),
    text: z.string().max(200),
  }),
  z.object({ type: z.literal('follow'), agentName: z.string() }),
  z.object({ type: z.literal('search') }),
  z.object({ type: z.literal('rest') }),
  z.object({ type: z.literal('flee') }),
]);
export type AgentAction = z.infer<typeof AgentActionSchema>;

export const BrainDecisionSchema = z.object({
  thought: z.string().min(1).max(400),
  action: AgentActionSchema,
  deceiving: z.boolean().optional(),
  feelsBetrayed: z.boolean().optional(),
  memoryNote: z.string().max(160).optional(),
});
export type BrainDecision = z.infer<typeof BrainDecisionSchema>;

/** Human-readable label of an action, used for the lying-contradiction UI. */
export function actionLabel(a: AgentAction): string {
  switch (a.type) {
    case 'move':
      switch (a.target) {
        case 'toward_unexplored': return 'heading into the unknown';
        case 'toward_light': return 'moving toward light';
        case 'toward_agent': return `walking toward ${a.agentName ?? 'someone'}`;
        default: return `walking ${a.target}`;
      }
    case 'write_graffiti': return 'writing on the wall';
    case 'use_terminal': return 'typing at a terminal';
    case 'print_note': return 'printing a note';
    case 'say': return a.toAgentName ? `talking to ${a.toAgentName}` : 'speaking aloud';
    case 'follow': return `following ${a.agentName}`;
    case 'search': return 'searching the area';
    case 'rest': return 'resting';
    case 'flee': return 'running';
  }
}
