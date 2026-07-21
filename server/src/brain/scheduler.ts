import { config } from '../config.js';
import { kv } from '../db/repo.js';
import type { World } from '../sim/world.js';
import { executeDecision } from '../sim/agents.js';
import type { AgentRuntime } from '../sim/agents.js';
import type { Brain } from './brain.js';
import { buildObservation } from './observation.js';
import { MockBrain } from './mockBrain.js';
import { OpenAIBrain, generateChaosLines, type LlmStats } from './openaiBrain.js';

/**
 * Decision scheduler: paces LLM calls with concurrency + RPM caps, a daily
 * USD circuit breaker (flip to mock, never die), and spectator-aware
 * throttling (empty room -> agents think slower, history still accumulates).
 */
export class BrainScheduler {
  readonly stats: LlmStats = {
    callsToday: 0,
    usdToday: 0,
    parseFailures: 0,
    timeouts: 0,
    mockFallbacks: 0,
  };
  private brains = new Map<string, Brain>();
  private inFlight = 0;
  private callTimes: number[] = [];
  private dayKey = '';
  private timer: NodeJS.Timeout | null = null;
  private chaosTimer: NodeJS.Timeout | null = null;

  constructor(private world: World) {
    this.rollDay();
  }

  start() {
    this.timer = setInterval(() => this.scan(), 500);
    if (config.BRAIN_MODE !== 'mock' && config.OPENAI_API_KEY) {
      this.chaosTimer = setInterval(() => this.refillChaosText(), 5 * 60 * 1000);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.chaosTimer) clearInterval(this.chaosTimer);
  }

  get budgetExceeded(): boolean {
    return this.stats.usdToday >= config.DAILY_USD_BUDGET;
  }

  private rollDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.dayKey === today) return;
    this.dayKey = today;
    this.stats.callsToday = 0;
    this.stats.usdToday = Number(kv.get(`usd:${today}`) ?? 0);
  }

  private recordUsage = (usd: number) => {
    this.stats.usdToday += usd;
    kv.set(`usd:${this.dayKey}`, String(this.stats.usdToday));
    if (this.budgetExceeded) {
      console.warn(
        `[brain] DAILY BUDGET EXCEEDED ($${this.stats.usdToday.toFixed(2)} >= $${config.DAILY_USD_BUDGET}). All brains fall back to mock until midnight UTC.`,
      );
    }
  };

  private brainFor(a: AgentRuntime): Brain {
    // global modes are authoritative; per-agent brainKind only matters in hybrid
    const modeWants =
      config.BRAIN_MODE === 'openai' ||
      (config.BRAIN_MODE === 'hybrid' && a.brainKind === 'openai');
    const wantOpenai = modeWants && !!config.OPENAI_API_KEY && !this.budgetExceeded;
    const desired = wantOpenai ? 'openai' : 'mock';
    let b = this.brains.get(a.id);
    if (!b || b.kind !== desired) {
      b =
        desired === 'openai'
          ? new OpenAIBrain(a.id, a.name, a.objective, this.stats, this.recordUsage)
          : new MockBrain(a.id);
      this.brains.set(a.id, b);
    }
    return b;
  }

  private rpmOk(now: number): boolean {
    this.callTimes = this.callTimes.filter((t) => now - t < 60000);
    return this.callTimes.length < config.LLM_RPM_CAP;
  }

  private scan() {
    this.rollDay();
    const now = Date.now();
    const idleWorld = this.world.spectatorCount === 0;
    const baseInterval = idleWorld
      ? Math.max(60000, config.DECISION_INTERVAL_MS)
      : config.DECISION_INTERVAL_MS;

    const due = [...this.world.agents.values()]
      .filter((a) => a.state !== 'dead' && !a.deciding && now >= a.nextDecisionAt)
      .sort((x, y) => x.nextDecisionAt - y.nextDecisionAt);

    for (const a of due) {
      const brain = this.brainFor(a);
      if (brain.kind === 'openai') {
        if (this.inFlight >= config.MAX_CONCURRENT_LLM || !this.rpmOk(now)) continue;
        this.callTimes.push(now);
        this.inFlight++;
      }
      a.deciding = true;
      const obs = buildObservation(this.world, a);
      brain
        .decide(obs)
        .then((decision) => {
          if (a.state !== 'dead') executeDecision(this.world, a, decision);
        })
        .catch((err) => console.error(`[brain] decide error for ${a.name}:`, err))
        .finally(() => {
          if (brain.kind === 'openai') this.inFlight--;
          a.deciding = false;
          // being hunted compresses time: thoughts race, ~3.5s apart,
          // regardless of spectator throttling
          const chased =
            this.world.monsterRt.mode === 'hunt' &&
            this.world.monsterRt.targetAgentId === a.id;
          const interval = chased ? 3500 : baseInterval;
          a.nextDecisionAt = Date.now() + interval * (0.75 + Math.random() * 0.5);
        });
    }
  }

  private async refillChaosText() {
    if (this.budgetExceeded) return;
    const names = [...this.world.agents.values()]
      .filter((a) => a.state !== 'dead')
      .map((a) => a.name);
    const lines = await generateChaosLines(names);
    if (lines) {
      this.world.chaosText.add('note', lines.note);
      this.world.chaosText.add('terminal', lines.terminal);
      this.world.chaosText.add('graffiti', lines.graffiti);
    }
  }
}
