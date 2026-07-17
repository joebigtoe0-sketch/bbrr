import { nanoid } from 'nanoid';
import type { WorldEvent, WorldEventType } from '@backrooms/shared';
import { eventRepo } from '../db/repo.js';

/**
 * Typed world-event bus. Three fixed consumers: world mutators (registered by
 * World), SQLite persistence (here), and the ws broadcast (accumulator drained
 * per tick). Producers: admin REST, the simulated-social module, sim lifecycle
 * code. Real X/on-chain feeds later are just additional producers.
 */
export class EventBus {
  /** drained into each delta broadcast */
  readonly pending: WorldEvent[] = [];
  private handlers: ((e: WorldEvent) => void)[] = [];

  constructor(private getTick: () => number) {}

  on(handler: (e: WorldEvent) => void) {
    this.handlers.push(handler);
  }

  emit(type: WorldEventType, payload: Record<string, unknown>): WorldEvent {
    const e: WorldEvent = { id: nanoid(8), type, payload, tick: this.getTick() };
    eventRepo.insert(type, payload, e.tick);
    this.pending.push(e);
    for (const h of this.handlers) h(e);
    return e;
  }
}
