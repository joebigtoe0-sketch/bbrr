import { config } from '../config.js';
import { caseFileRepo, memoryRepo, thoughtRepo } from '../db/repo.js';
import { getClient } from './openaiBrain.js';
import type { AgentRuntime } from '../sim/agents.js';

/**
 * When an agent dies, its whole recorded life — thoughts, memories, cause of
 * death — condenses into a case file: the maze's archive becomes literature.
 * LLM-written when possible; a factual template otherwise. Fire-and-forget.
 */
export async function writeCaseFile(a: AgentRuntime, cause: string) {
  const thoughts = thoughtRepo.lastN(a.id, 40).reverse();
  const memory = memoryRepo.get(a.id);
  const lifespanMin = Math.max(1, Math.round((Date.now() - a.spawnedAtMs) / 60000));

  let story =
    `Subject entered the maze driven to "${a.objective}". ` +
    `Survived ${lifespanMin} minutes. Recorded ${thoughts.length} thoughts. ` +
    (memory.summary ? `Fragments recovered: ${memory.summary.slice(0, 300)} ` : '') +
    (thoughts.length > 0 ? `Final recorded thought: "${thoughts[thoughts.length - 1]!.text}" ` : '') +
    `Cause of termination: ${cause}.`;

  if (config.BRAIN_MODE !== 'mock' && config.OPENAI_API_KEY) {
    try {
      const sample = thoughts
        .filter((_, i) => i % Math.max(1, Math.floor(thoughts.length / 12)) === 0)
        .map((t) => `- ${t.text}`)
        .join('\n');
      const res = await getClient().chat.completions.create({
        model: config.OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You write CASE FILES for residents who died in an endless backrooms maze. Third person, past tense, 90-150 words, the register of a coroner who has seen too much and started editorializing. Include what drove them, how they changed, what they left behind, and how it ended. No headers, no lists — one paragraph.',
          },
          {
            role: 'user',
            content:
              `Name: ${a.name}\nDrive: ${a.objective}\nSurvived: ${lifespanMin} minutes\n` +
              `Cause of death: ${cause}\nMemory summary: ${memory.summary || '(none)'}\n` +
              `Recent memories: ${memory.notes.join(' | ') || '(none)'}\nSampled thoughts:\n${sample || '(none)'}`,
          },
        ],
        max_tokens: 280,
        temperature: 0.9,
      });
      const out = res.choices[0]?.message?.content?.trim();
      if (out) story = out;
    } catch (err) {
      console.warn(`[casefile] generation failed for ${a.name}: ${(err as Error).message}`);
    }
  }

  caseFileRepo.insert(a.id, a.name, a.objective, story, a.spawnedAtMs, Date.now(), cause);
  console.log(`[casefile] archived ${a.name}`);
}
