import type { World } from './world.js';

/**
 * Simulated social module: the outside world "reacts" to notable agents.
 * Every 2 minutes, each agent rolls for a viral post proportional to its
 * recent notable actions (terminal posts, graffiti, conversations).
 * A real X feed later replaces these rolls with real signals emitting the
 * exact same 'viral_post' events.
 */
export function rollViral(world: World) {
  for (const a of world.agents.values()) {
    if (a.state === 'dead') continue;
    const p = Math.min(0.3, a.notable * 0.04);
    if (Math.random() < p) {
      const magnitude = 5 + Math.floor(Math.random() * 25);
      world.bus.emit('viral_post', { agentId: a.id, magnitude, simulated: true });
      a.notable = 0;
    }
  }
}
