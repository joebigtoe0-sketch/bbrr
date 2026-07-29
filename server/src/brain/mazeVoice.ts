import { config } from '../config.js';
import { tweetRepo } from '../db/repo.js';
import type { World } from '../sim/world.js';
import { getClient } from './openaiBrain.js';

/**
 * The maze's own voice. Nothing is posted anywhere by this class directly —
 * tweets accumulate internally (TWEETS panel) and the X integration drains the
 * same 'maze_tweet' events when live.
 *
 * Cadence: 2-5 posts/hour, weighted toward the higher end early on, then
 * settling down. Event-driven (deaths, hunts, arrivals...) plus an ambient
 * pool, all gated by one shared cooldown so the account never spams.
 *
 * Voice: rotates across many registers so it never reads as one repeated
 * "intercepted transmission" template.
 */

// ambient posts pulled at random — each a different register/format so the
// feed stays varied even in mock mode (no LLM). {brief} guides the LLM rewrite.
const AMBIENT: { brief: string; fallback: string }[] = [
  {
    brief: 'A mock-cheerful facilities/management memo about the maze. Absurd, bureaucratic, faintly threatening.',
    fallback: 'reminder: the exits are for your safety and cannot be located at this time. thank you for your continued residency.',
  },
  {
    brief: 'A weather report for a place with no sky.',
    fallback: 'forecast: humid. the walls will sweat after 3am. no 3am is scheduled. dress accordingly.',
  },
  {
    brief: 'A lost-and-found notice for something impossible or sad.',
    fallback: 'lost & found: one wristwatch, still ticking, no owner. one sense of direction, badly worn. claim at any terminal.',
  },
  {
    brief: 'A single cryptic line, almost a koan, about the maze.',
    fallback: 'the hallway you remember is not the hallway that remembers you.',
  },
  {
    brief: 'A fake maintenance advisory. Dry, unsettling.',
    fallback: 'maintenance advisory: fluorescents in sector 7 will flicker on schedule. sector 7 has not been built. we apologize for the inconvenience.',
  },
  {
    brief: 'A cheerful PA-style announcement that lands wrong.',
    fallback: 'attention residents: it is a beautiful day to keep walking. it is always a beautiful day to keep walking.',
  },
  {
    brief: 'A terse status line, like a system heartbeat, with one wrong detail.',
    fallback: 'status: nominal. carpet moisture nominal. resident count nominal. one resident is counted twice. this is nominal.',
  },
  {
    brief: 'An overheard fragment, as if the walls quoted someone.',
    fallback: 'overheard, sector unknown: "i think the lights are following me." the lights decline to comment.',
  },
  {
    brief: 'A bland lie stated as fact.',
    fallback: 'the north wing has been fully mapped and is completely safe. there is no north wing.',
  },
  {
    brief: 'A note about the residents, cold and observational.',
    fallback: 'the residents have started leaving notes for each other. the notes rarely find their reader. we keep the ones that do.',
  },
];

const DEATH_FALLBACKS = (name: string, cause: string) => [
  `headcount -1. ${name} is no longer moving. cause on file: "${cause}". the carpet is already forgetting.`,
  `${name} has concluded their residency. no forwarding address. the halls did not slow for it.`,
  `incident logged: ${name}. "${cause}." the maze remains, as ever, at capacity minus one.`,
];

export class MazeVoice {
  private lastTweetAt = 0;
  private startedAt = Date.now();
  private ambientTimer: NodeJS.Timeout | null = null;
  private pendingContext: string[] = [];

  constructor(private world: World) {}

  /** the shared cooldown — long, and longer as the world ages (rate falls) */
  private cooldownMs(): number {
    const hours = (Date.now() - this.startedAt) / 3_600_000;
    // ~12 min early (≈5/hr) ramping to ~28 min (≈2/hr) over the first ~1.5h
    const minutes = Math.min(28, 12 + hours * 11);
    return minutes * 60_000;
  }

  start() {
    this.world.bus.on((e) => {
      switch (e.type) {
        case 'agent_died': {
          const name = String(e.payload.name);
          const cause = String(e.payload.cause);
          this.compose(
            'death',
            `${name} died: ${cause}. Write about it — an incident note, an obituary fragment, or a cold remark. Pick a register you have not used recently.`,
            pick(DEATH_FALLBACKS(name, cause)),
            true,
          );
          break;
        }
        case 'agent_spawned':
          if (Math.random() < 0.5)
            this.compose(
              'arrival',
              `A newcomer woke up: ${e.payload.name}, driven to "${e.payload.objective}". Note the arrival in some fresh way.`,
              `headcount +1. they say their name is ${e.payload.name}. the maze has made no promises.`,
            );
          break;
        case 'viral_post': {
          const a = e.payload.agentId ? this.world.agents.get(e.payload.agentId as string) : null;
          if (a && Math.random() < 0.45)
            this.compose(
              'attention',
              `Outside attention surged around ${a.name}; a sector's lights came on. Remark on the outside world noticing.`,
              `attention detected around ${a.name}. one sector illuminated. the light is a loan; the interest is steep.`,
            );
          break;
        }
        case 'terminal_post':
          if (Math.random() < 0.25)
            this.compose(
              'intercept',
              `${e.payload.name} typed this into a terminal, believing it reaches outside: "${e.payload.text}". React to it — quote it, answer it, or ignore its meaning entirely. Vary the framing.`,
              `a message left a terminal tonight. ${e.payload.name}: "${e.payload.text}". it did not go where they hoped.`,
            );
          break;
        case 'hunt_started':
          if (Math.random() < 0.4)
            this.compose(
              'hunt',
              `The thing in the halls has started hunting ${e.payload.name}. Remark coldly, or with false calm.`,
              `movement in the halls. ${e.payload.name} has been selected. the maze remains neutral on outcomes.`,
              true,
            );
          break;
      }
    });
    // ambient candidate on a slow timer; the cooldown decides if it actually posts
    this.ambientTimer = setInterval(() => this.ambient(), 5 * 60 * 1000);
  }

  stop() {
    if (this.ambientTimer) clearInterval(this.ambientTimer);
  }

  private ambient() {
    const living = [...this.world.agents.values()].filter((a) => a.state !== 'dead');
    const names = living.map((a) => a.name).join(', ') || 'nobody';
    const a = pick(AMBIENT);
    this.compose('ambient', `${a.brief} (current residents: ${names})`, a.fallback);
  }

  /** queue-with-cooldown composer; priority events may fire a little sooner */
  private compose(kind: string, llmBrief: string, fallback: string, priority = false) {
    const now = Date.now();
    const cooldown = priority ? Math.max(8 * 60_000, this.cooldownMs() * 0.6) : this.cooldownMs();
    if (now - this.lastTweetAt < cooldown) {
      this.pendingContext.push(llmBrief);
      if (this.pendingContext.length > 6) this.pendingContext.shift();
      return;
    }
    this.lastTweetAt = now;
    void this.write(kind, llmBrief, fallback);
  }

  private async write(kind: string, brief: string, fallback: string) {
    let text = fallback;
    if (config.BRAIN_MODE !== 'mock' && config.OPENAI_API_KEY) {
      try {
        const context = this.pendingContext.splice(0).join(' | ');
        const res = await getClient().chat.completions.create({
          model: config.OPENAI_MODEL,
          messages: [
            {
              role: 'system',
              content:
                'You are the voice of an endless nightrooms maze that holds living residents. Write ONE post. ' +
                'LENGTH: usually short and punchy (a line or two). But roughly one time in four, let it RUN LONGER — ' +
                'a full maintenance advisory, a rambling management memo, a cold multi-sentence obituary, a page of procedure. ' +
                'Vary it; never the same length twice in a row. ' +
                'CRUCIAL: rotate your register every time — do NOT default to "incident report" or "intercepted transmission". ' +
                'Draw from: management memos, PA announcements, lost-and-found notices, fake maintenance advisories, weather reports for a place with no sky, ' +
                'cryptic one-liners, overheard fragments, bland lies stated as fact, cold obituaries, mock-cheerful reassurances. ' +
                'Dry, bureaucratic-eldritch. Lowercase except codes. Never repeat an opener you might have used before. No hashtags, no emoji. ' +
                'You are not evil; you are procedure. Output ONLY the post text.',
            },
            { role: 'user', content: context ? `${brief}\n(also unremarked recently: ${context})` : brief },
          ],
          max_tokens: 800,
          temperature: 1.05,
        });
        const out = res.choices[0]?.message?.content?.trim();
        if (out) text = out;
      } catch (err) {
        console.warn(`[voice] tweet generation failed: ${(err as Error).message}`);
      }
    }
    tweetRepo.insert(text, kind, this.world.tick);
    this.world.bus.emit('maze_tweet', { text, kind });
  }
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}
