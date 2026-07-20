import { config } from '../config.js';
import { tweetRepo } from '../db/repo.js';
import type { World } from '../sim/world.js';
import { getClient } from './openaiBrain.js';

/**
 * The maze's own voice: dry, bureaucratic-eldritch. Nothing is actually
 * posted anywhere — tweets accumulate internally (TWEETS panel) until a
 * real X integration is wired to drain the same queue.
 *
 * Event-driven with a cooldown, plus an ambient observation on a slow timer.
 * LLM writes the copy when a key is present; canned templates otherwise.
 */
export class MazeVoice {
  private lastTweetAt = 0;
  private ambientTimer: NodeJS.Timeout | null = null;
  private pendingContext: string[] = [];

  constructor(private world: World) {}

  start() {
    this.world.bus.on((e) => {
      switch (e.type) {
        case 'agent_died':
          this.compose(
            'death',
            `${e.payload.name} died: ${e.payload.cause}. Write the incident report.`,
            `headcount -1. ${e.payload.name} is no longer moving. cause on file: "${e.payload.cause}". the carpet is already forgetting.`,
            true,
          );
          break;
        case 'agent_spawned':
          if (Math.random() < 0.6)
            this.compose(
              'arrival',
              `A newcomer woke up: ${e.payload.name}, driven to "${e.payload.objective}". Announce the arrival.`,
              `headcount +1. they say their name is ${e.payload.name}. the maze has made no promises.`,
            );
          break;
        case 'viral_post': {
          const a = e.payload.agentId ? this.world.agents.get(e.payload.agentId as string) : null;
          if (a && Math.random() < 0.5)
            this.compose(
              'attention',
              `Outside attention surged around ${a.name}; a sector's lights came on. Note it.`,
              `attention detected. one sector illuminated, courtesy of ${a.name}. the light is a loan. the interest is steep.`,
            );
          break;
        }
        case 'terminal_post':
          if (Math.random() < 0.45)
            this.compose(
              'intercept',
              `${e.payload.name} typed this into a terminal, believing it reaches the outside: "${e.payload.text}". Quote it as an intercepted transmission with one dry remark.`,
              `intercepted transmission // ${e.payload.name}: "${e.payload.text}"`,
            );
          break;
        case 'hunt_started':
          if (Math.random() < 0.5)
            this.compose(
              'hunt',
              `The thing in the halls has started hunting ${e.payload.name}. Remark on it, coldly.`,
              `movement in the halls. ${e.payload.name} has been selected. the maze remains neutral on outcomes.`,
              true,
            );
          break;
      }
    });
    this.ambientTimer = setInterval(() => this.ambient(), 15 * 60 * 1000);
  }

  stop() {
    if (this.ambientTimer) clearInterval(this.ambientTimer);
  }

  private ambient() {
    const living = [...this.world.agents.values()].filter((a) => a.state !== 'dead');
    const names = living.map((a) => a.name).join(', ') || 'nobody';
    this.compose(
      'ambient',
      `Nothing special happened. Current residents: ${names}. Make one unsettling ambient observation about the maze or its residents.`,
      `status: ${living.length} residents. the fluorescents hum at 59.94hz. this is not the correct frequency. nothing hums at the correct frequency anymore.`,
    );
  }

  /** queue-with-cooldown composer; priority events shorten the cooldown */
  private compose(kind: string, llmBrief: string, fallback: string, priority = false) {
    const now = Date.now();
    const cooldown = priority ? 60_000 : 180_000;
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
                'You are the voice of an endless backrooms maze that holds living residents. You write short posts (under 240 chars) in a dry, bureaucratic-eldritch register: incident reports, headcount notices, intercepted transmissions. Lowercase except codes. Never use hashtags or emoji. You are not evil; you are procedure. Occasionally you lie, blandly. Output ONLY the post text.',
            },
            { role: 'user', content: context ? `${brief}\n(also unremarked recently: ${context})` : brief },
          ],
          max_tokens: 120,
          temperature: 1.0,
        });
        const out = res.choices[0]?.message?.content?.trim();
        if (out) text = out.slice(0, 270);
      } catch (err) {
        console.warn(`[voice] tweet generation failed: ${(err as Error).message}`);
      }
    }
    tweetRepo.insert(text, kind, this.world.tick);
    this.world.bus.emit('maze_tweet', { text, kind });
  }
}
