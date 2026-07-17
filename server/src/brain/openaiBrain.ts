import OpenAI from 'openai';
import { BrainDecisionSchema } from '@backrooms/shared';
import type { BrainDecision, Objective } from '@backrooms/shared';
import { config } from '../config.js';
import type { Brain, Observation } from './brain.js';
import { MockBrain } from './mockBrain.js';
import { systemPrompt, userPrompt } from './prompt.js';

// rough gpt-4o-mini-class pricing for the budget circuit breaker (USD per 1M tokens)
const USD_PER_M_IN = 0.15;
const USD_PER_M_OUT = 0.6;

export interface LlmStats {
  callsToday: number;
  usdToday: number;
  parseFailures: number;
  timeouts: number;
  mockFallbacks: number;
}

let client: OpenAI | null = null;
export function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: config.OPENAI_API_KEY, baseURL: config.OPENAI_BASE_URL });
  }
  return client;
}

export class OpenAIBrain implements Brain {
  readonly kind = 'openai' as const;
  private system: string;
  private fallback: MockBrain;

  constructor(
    agentId: string,
    name: string,
    objective: Objective,
    private stats: LlmStats,
    private onUsage: (usd: number) => void,
  ) {
    this.system = systemPrompt(name, objective);
    this.fallback = new MockBrain(agentId);
  }

  async decide(obs: Observation): Promise<BrainDecision> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await getClient().chat.completions.create(
        {
          model: config.OPENAI_MODEL,
          messages: [
            { role: 'system', content: this.system },
            { role: 'user', content: userPrompt(obs) },
          ],
          response_format: { type: 'json_object' },
          max_tokens: 300,
          temperature: 0.9,
        },
        { signal: controller.signal },
      );
      this.stats.callsToday++;
      const usage = res.usage;
      if (usage) {
        const usd =
          (usage.prompt_tokens / 1e6) * USD_PER_M_IN +
          (usage.completion_tokens / 1e6) * USD_PER_M_OUT;
        this.onUsage(usd);
      }
      const raw = res.choices[0]?.message?.content ?? '';
      const parsed = parseDecision(raw);
      if (parsed) return parsed;
      this.stats.parseFailures++;
      console.warn(`[brain] parse failure, falling back to mock. raw: ${raw.slice(0, 200)}`);
    } catch (err) {
      if ((err as Error).name === 'AbortError') this.stats.timeouts++;
      else console.warn(`[brain] LLM call failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
    this.stats.mockFallbacks++;
    return this.fallback.decide(obs);
  }
}

export function parseDecision(raw: string): BrainDecision | null {
  let text = raw.trim();
  // strip markdown fences some models insist on
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1]!.trim();
  try {
    const obj = JSON.parse(text);
    const result = BrainDecisionSchema.safeParse(obj);
    if (result.success) return result.data;
  } catch {
    // fall through
  }
  return null;
}

/** One batched call generating fresh chaos-agent copy. Cheap; every ~5 min. */
export async function generateChaosLines(
  agentNames: string[],
): Promise<{ note: string[]; terminal: string[]; graffiti: string[] } | null> {
  try {
    const res = await getClient().chat.completions.create({
      model: config.OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You write short, unsettling, darkly funny in-world text for a trickster entity haunting an endless yellow-room labyrinth. Residents currently inside: ' +
            (agentNames.join(', ') || 'none') +
            '. Never mention games, simulations, or the internet. Output ONLY JSON: {"note": string[4], "terminal": string[4], "graffiti": string[4]} — each string under 120 chars.',
        },
        { role: 'user', content: 'Generate a fresh batch.' },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 500,
      temperature: 1.0,
    });
    const raw = res.choices[0]?.message?.content ?? '';
    const obj = JSON.parse(raw);
    return {
      note: Array.isArray(obj.note) ? obj.note : [],
      terminal: Array.isArray(obj.terminal) ? obj.terminal : [],
      graffiti: Array.isArray(obj.graffiti) ? obj.graffiti : [],
    };
  } catch (err) {
    console.warn(`[chaos] text generation failed: ${(err as Error).message}`);
    return null;
  }
}
