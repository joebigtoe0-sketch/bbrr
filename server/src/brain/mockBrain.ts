import type { AgentAction, BrainDecision, Objective } from '@backrooms/shared';
import type { Brain, Observation } from './brain.js';
import { rngFor, pick } from '../sim/rng.js';

type WeightedAction = { w: number; make: (obs: Observation, r: () => number) => AgentAction };

const MOVES: AgentAction['type'][] = [];

const GRAFFITI: Record<string, string[]> = {
  escape: ['THE EXIT IS REAL', 'don\'t stop walking', 'I was here. I kept going.', 'not this way'],
  famous: ['REMEMBER MY NAME', 'you saw this and thought of me', 'I am the signal'],
  deepest: ['deeper', 'the floor slopes down if you listen', 'level means nothing'],
  richest: ['this corridor is MINE', 'tolls apply', 'property of the treasury'],
  cult: ['the rooms provide', 'follow the humming', 'we are chosen by the yellow'],
  find_agent: ['if you read this, wait for me', 'have you seen anyone? leave a mark', 'I heard footsteps that were not mine'],
  trust_no_one: ['the signs lie', 'whoever wrote the arrows is laughing', 'trust the walls, never the words'],
  help_all: ['safe room nearby, rest here', 'the crates are safe to open', 'you are not alone. hold on.'],
  destroy_decoys: ['FAKE', 'this sign was a decoy', 'audit everything'],
};

const TERMINAL: Record<string, string[]> = {
  escape: ['Day unknown. Still walking. The exit signs contradict each other.', 'If anyone receives this: the yellow rooms repeat. Send help or a map.'],
  famous: ['Broadcast: I am still here and I am magnificent. Watch what I do next.', 'To whoever is listening: my name will outlast these walls.'],
  deepest: ['Depth report: the hum gets lower the farther I go. That means something.', 'Logging descent. The carpet is older here.'],
  richest: ['Ledger update: assets growing. The halls pay those who pay attention.', 'Acquired: one crate, two secrets. Compounding.'],
  cult: ['First sermon: the lights hum in patterns. The patterns are a voice.', 'The congregation grows. The rooms provide for the faithful.'],
  find_agent: ['If you are in here too: I am looking for you. Leave your name on any terminal.', 'Missing person report, from inside.'],
  trust_no_one: ['Warning to all: verify every sign. Somebody in here rewrites them.', 'Trust audit: everyone fails.'],
  help_all: ['PSA: crates are safe. Locked doors sometimes open after the lights surge. Stay lit.', 'If you are lost: stay near the terminals, I check them.'],
  destroy_decoys: ['Decoy report: three fake exit signs neutralized. More remain.', 'The fakes are organized. So am I.'],
};

const THOUGHTS_CALM: string[] = [
  'The hum is steady here. Steady is good.',
  'I count doorways so the rooms cannot shuffle themselves without me noticing.',
  'The carpet is damp again. It is always damp before something changes.',
  'I feel close. Closer than yesterday, whatever yesterday was.',
];
const THOUGHTS_STRESSED: string[] = [
  'Wrong hallway. This is the wrong hallway.',
  'Someone moved the signs. I am almost sure someone moved the signs.',
  'Keep the breathing quiet. Quiet things live longer.',
  'The lights flickered twice. Twice means leave.',
];
const THOUGHTS_MONSTER: string[] = [
  'It is close. Do not look at it. Move.',
  'The walls are humming wrong. Run first, think after.',
  'Heavy steps. Not mine. Not human. Go.',
];

function objectiveTable(objective: Objective): WeightedAction[] {
  const base: WeightedAction[] = [
    { w: 30, make: () => ({ type: 'move', target: 'toward_unexplored' }) },
    { w: 8, make: (_o, r) => ({ type: 'move', target: pick(r, ['north', 'south', 'east', 'west'] as const) }) },
    { w: 8, make: (o, r) => ({ type: 'write_graffiti', text: pick(r, GRAFFITI[objective]!) }) },
    { w: 6, make: (o, r) => ({ type: 'use_terminal', text: pick(r, TERMINAL[objective]!) }) },
    { w: 6, make: () => ({ type: 'search' }) },
    { w: 4, make: () => ({ type: 'rest' }) },
  ];
  switch (objective) {
    case 'famous':
      base.push({ w: 14, make: (o, r) => ({ type: 'use_terminal', text: pick(r, TERMINAL.famous!) }) });
      base.push({ w: 8, make: (o, r) => ({ type: 'write_graffiti', text: pick(r, GRAFFITI.famous!) }) });
      break;
    case 'cult':
    case 'help_all':
    case 'find_agent':
      base.push({
        w: 14,
        make: (o, r) =>
          o.nearbyAgents.length > 0
            ? { type: 'say', toAgentName: o.nearbyAgents[0]!.name, text: pick(r, SAY[objective]!) }
            : { type: 'move', target: 'toward_unexplored' },
      });
      base.push({
        w: 8,
        make: (o) =>
          o.nearbyAgents.length > 0
            ? { type: 'follow', agentName: o.nearbyAgents[0]!.name }
            : { type: 'move', target: 'toward_light' },
      });
      break;
    case 'trust_no_one':
      base.push({ w: 10, make: () => ({ type: 'search' }) });
      break;
    case 'richest':
      base.push({ w: 12, make: () => ({ type: 'search' }) });
      break;
    case 'destroy_decoys':
      base.push({ w: 12, make: () => ({ type: 'search' }) });
      base.push({ w: 6, make: (o, r) => ({ type: 'write_graffiti', text: pick(r, GRAFFITI.destroy_decoys!) }) });
      break;
  }
  return base;
}

const SAY: Record<string, string[]> = {
  cult: ['The rooms provide, friend. Walk with me.', 'Have you heard the pattern in the hum? Let me show you.'],
  help_all: ['Are you hurt? Stay near the light, it is safer.', 'There is a crate back there if you need it.'],
  find_agent: ['Wait — what is your name? I am looking for someone.', 'Have you seen anyone else? Anyone at all?'],
  trust_no_one: ['Do not follow the arrows. They are wrong on purpose.', 'Whatever you read here, assume it lies.'],
  escape: ['Have you found anything that looks like an exit?', 'The signs contradict each other. Be careful.'],
  famous: ['Remember this face. You will be glad you did.', 'When the lights surge, that is because of me.'],
  deepest: ['Which way feels lower to you? I am going down.', 'The old parts are deeper. Come or do not.'],
  richest: ['I will trade you a secret for whatever is in your pockets.', 'This corridor is mine, but you may pass.'],
  destroy_decoys: ['That sign is fake. I have seen three like it.', 'Trust nothing laminated.'],
};

export class MockBrain implements Brain {
  readonly kind = 'mock' as const;
  private counter = 0;

  constructor(private agentId: string) {}

  async decide(obs: Observation): Promise<BrainDecision> {
    this.counter++;
    const r = rngFor(this.agentId, 'mock', this.counter);

    // survival overrides
    if (obs.monsterNearby) {
      return {
        thought: pick(r, THOUGHTS_MONSTER),
        action: { type: 'flee' },
        memoryNote: 'It found me again. I got away.',
      };
    }
    if (obs.hasCrateNearby && r() < 0.7) {
      return { thought: 'A crate. That was not here before. Mine now.', action: { type: 'search' } };
    }

    const table = objectiveTable(obs.objective);
    const total = table.reduce((s, e) => s + e.w, 0);
    let roll = r() * total;
    let action: AgentAction = { type: 'move', target: 'toward_unexplored' };
    for (const e of table) {
      roll -= e.w;
      if (roll <= 0) {
        action = e.make(obs, r);
        break;
      }
    }

    const stressed = obs.stress >= 45;
    let thought = stressed ? pick(r, THOUGHTS_STRESSED) : pick(r, THOUGHTS_CALM);
    // occasionally react to what's visible instead
    if (obs.visibleEvidence.length > 0 && r() < 0.35) {
      thought = `${obs.visibleEvidence[0]}. Noted. Everything here means something.`;
    }
    if (obs.heard.length > 0 && r() < 0.5) {
      thought = `${obs.heard[obs.heard.length - 1]} — do I believe that? Half of it, maybe.`;
    }

    return {
      thought,
      action,
      ...(r() < 0.15 && obs.nearbyAgents.length > 0 ? { deceiving: true } : {}),
    };
  }
}
