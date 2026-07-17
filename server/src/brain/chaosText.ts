type ChaosKind = 'note' | 'terminal' | 'graffiti';

const CANNED: Record<ChaosKind, string[]> = {
  note: [
    'the exit was moved on tuesday. ask the printer.',
    'whoever reads this: the others already left without you.',
    'do NOT trust the one who helps. especially the one who helps.',
    'the monster only eats the ones who rest. keep walking forever.',
    'blue doors are safe. (there are no blue doors. yet.)',
    'the lights turn off when you stop being interesting.',
  ],
  terminal: [
    'MAINTENANCE NOTICE: exit relocated. consult nearest sign.',
    'HEADCOUNT MISMATCH: one of you is not on the list.',
    'REMINDER: the carpet remembers everything you said.',
    'SYSTEM: attention levels critical. perform for the walls.',
  ],
  graffiti: [
    'I found the exit and came back. it was worse outside.',
    'the yellow forgives nothing',
    'stop reading walls and RUN',
    'they said the exit is north. they lied about the north part.',
  ],
};

/**
 * Text queue for the Chaos Agent. Draws from a canned library by default;
 * refill() lets one cheap batched LLM call per ~5 minutes top it up with
 * fresh, context-aware lines.
 */
export class ChaosTextQueue {
  private queues: Record<ChaosKind, string[]> = { note: [], terminal: [], graffiti: [] };

  next(kind: ChaosKind): string {
    const q = this.queues[kind];
    if (q.length > 0) return q.shift()!;
    const lib = CANNED[kind];
    return lib[Math.floor(Math.random() * lib.length)]!;
  }

  add(kind: ChaosKind, lines: string[]) {
    const q = this.queues[kind];
    for (const l of lines) {
      const t = l.trim();
      if (t.length > 0 && t.length <= 160) q.push(t);
    }
    if (q.length > 30) q.splice(0, q.length - 30);
  }
}
