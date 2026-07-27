import { ThreeWorld } from './three/ThreeWorld.js';
import {
  appendLog,
  initReader,
  initRightPanel,
  initSpawnModal,
  openReader,
  playTuneIn,
  refreshDeaths,
  refreshTweets,
  renderAgentList,
  toast,
} from './ui/dom.js';
import type { Agent, WorldEvent } from '@backrooms/shared';

const app = document.getElementById('app')!;
const world = new ThreeWorld(app);
const store = world.store;

// overlay layer for in-world HTML (labels, thoughts)
const overlay = document.createElement('div');
overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:6;overflow:hidden';
document.body.appendChild(overlay);

// ---------------- sidebar + panels ----------------
initReader();
initRightPanel();
refreshDeaths();
setInterval(refreshDeaths, 30000);

let tunedId: string | null = null;
setInterval(() => {
  renderAgentList([...store.agents.values()], tunedId, { onAgentClick: (id) => tuneIn(id) });
}, 600);

initSpawnModal((agentId) => {
  const tryFocus = (n: number) => {
    if (store.agents.has(agentId)) world.setFollow(agentId);
    else if (n > 0) setTimeout(() => tryFocus(n - 1), 300);
  };
  tryFocus(10);
});

// ---------------- tune-in + thoughts ----------------
function tuneIn(id: string) {
  const a = store.agents.get(id);
  if (!a) return;
  world.setFollow(id);
  if (tunedId === id) return;
  tunedId = id;
  playTuneIn(a.name, () => sendWs({ t: 'tune_in', agentId: id }));
}
world.onTuneIn = (id) => tuneIn(id);
world.onEvidenceClick = (id) => {
  const e = store.evidence.get(id);
  if (!e) return;
  if (e.kind === 'crt') {
    const lines = (e.meta?.lines as string[] | undefined) ?? [];
    openReader('TERMINAL // internal log', lines.length ? lines : ['[the cursor blinks]']);
  } else {
    openReader(e.kind.toUpperCase(), [e.text ?? '(blank)', ...(e.authorName ? ['', `— ${e.authorName}`] : [])]);
  }
};

interface Floater {
  el: HTMLDivElement;
  agentId: string;
  born: number;
}
const floaters: Floater[] = [];
const labels = new Map<string, HTMLDivElement>();
const monMarker = document.createElement('div');
monMarker.textContent = '⚠';
monMarker.style.cssText = 'position:absolute;color:#ff3a2a;font:bold 18px Consolas,monospace;text-shadow:0 0 6px #000;transform:translate(-50%,-100%);display:none';
overlay.appendChild(monMarker);
store.onThought = (t) => {
  if (t.agentId !== tunedId) return;
  const el = document.createElement('div');
  el.textContent = t.text;
  const color = t.mindState === 'panicked' ? '#ff5d5d' : t.mindState === 'stressed' ? '#ffc46b' : t.mindState === 'deceptive' ? '#c99aff' : '#7dff9a';
  el.style.cssText = `position:absolute;max-width:230px;font:italic 13px Consolas,monospace;color:${color};text-shadow:0 0 4px #000,0 0 2px #000;transform:translate(-50%,-100%);text-align:center`;
  overlay.appendChild(el);
  floaters.push({ el, agentId: t.agentId, born: performance.now() });
};
store.onSpeech = (agentId, text) => {
  const who = store.agents.get(agentId)?.name ?? '???';
  appendLog(`${who}: "${text}"`, 'speech');
};

// ---------------- auto-director ----------------
// when on, the camera follows wherever the drama is: proximity to the monster,
// panic, someone being hunted. hunts snap instantly; otherwise it drifts on a
// timer with hysteresis so it doesn't flicker between agents.
let directorOn = false;
let lastDirectorSwitch = 0;
const dirBtn = document.getElementById('director') as HTMLButtonElement;
dirBtn.onclick = () => {
  directorOn = !directorOn;
  dirBtn.classList.toggle('active', directorOn);
  if (directorOn) pickDirectorTarget(true);
};
function agentDrama(a: Agent): number {
  if (a.state === 'dead') return -1;
  let s = 0;
  const dm = Math.hypot(a.x - store.monster.x, a.y - store.monster.y);
  if (dm < 3) s += 130;
  else if (dm < 6) s += 90 - dm * 6;
  else if (dm < 12) s += 34 - dm;
  if (a.mindState === 'panicked') s += 60;
  else if (a.mindState === 'stressed') s += 22;
  else if (a.mindState === 'deceptive') s += 16;
  return s;
}
function pickDirectorTarget(force: boolean) {
  if (!directorOn) return;
  const now = performance.now();
  if (!force && now - lastDirectorSwitch < 4500) return;
  let best: string | null = null;
  let bestScore = -1;
  let curScore = -1;
  for (const a of store.agents.values()) {
    const sc = agentDrama(a);
    if (a.id === tunedId) curScore = sc;
    if (sc > bestScore) { bestScore = sc; best = a.id; }
  }
  if (!best) return;
  // only jump if the best is meaningfully more interesting than who we watch now
  if (best !== tunedId && (force || bestScore > curScore + 15 || curScore < 0)) {
    lastDirectorSwitch = now;
    tuneIn(best);
  }
}
setInterval(() => pickDirectorTarget(false), 1500);

// ---------------- log feed ----------------
store.onWorldEvent = (e: WorldEvent) => {
  const p = e.payload as Record<string, string>;
  switch (e.type) {
    case 'agent_spawned': appendLog(`+ ${p.name} entered the maze (${p.objective})`); break;
    case 'agent_died': appendLog(`☠ ${p.name} — ${p.cause}`, 'death'); toast(`☠ ${p.name}`); break;
    case 'hunt_started':
      appendLog(`⚠ the thing is hunting ${p.name}`, 'hunt'); toast(`⚠ hunting ${p.name}`);
      if (directorOn) {
        const hunted = [...store.agents.values()].find((a) => a.name === p.name);
        if (hunted) { lastDirectorSwitch = performance.now(); tuneIn(hunted.id); }
      }
      break;
    case 'terminal_post': appendLog(`[POST] ${p.name}: ${p.text}`); break;
    case 'maze_tweet': appendLog(`🕳 ${p.text}`, 'tweet'); void refreshTweets(); break;
    case 'incoming_tweet': appendLog(`🐦 @${p.handle}: ${p.text}`, 'tweet'); break;
    case 'viral_post': appendLog('⚡ attention surge — a sector lights up'); break;
    case 'buyback': appendLog('💡 buyback: power returns'); break;
    case 'corridor_collapse': appendLog('🔥 burn: hallways collapsed'); break;
    case 'airdrop': appendLog('📦 airdrop: crates fell'); break;
    case 'crate_drop': appendLog('📦 a supply crate appeared'); break;
    case 'liquidity_up': appendLog('🌊 the maze grew'); break;
    case 'door_unlock': appendLog('🔓 a door unlocked'); break;
  }
};

// ---------------- chunk subscription (camera-driven) ----------------
let lastSub = '';
setInterval(() => {
  const c = world.viewCenterTile();
  const r = 3;
  const cx = Math.floor(c.x / 16);
  const cy = Math.floor(c.y / 16);
  const sig = `${cx},${cy}`;
  if (sig === lastSub) return;
  lastSub = sig;
  const coords: { cx: number; cy: number }[] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) coords.push({ cx: cx + dx, cy: cy + dy });
  sendWs({ t: 'subscribe_chunks', coords });
}, 400);

// ---------------- contract address ----------------
// set once the token launches. left as a placeholder until then.
const CONTRACT_ADDRESS = '';
{
  const val = document.getElementById('ca-val')!;
  const copy = document.getElementById('ca-copy') as HTMLButtonElement;
  val.textContent = CONTRACT_ADDRESS || 'not live yet';
  if (!CONTRACT_ADDRESS) copy.disabled = true;
  copy.onclick = async () => {
    if (!CONTRACT_ADDRESS) return;
    try {
      await navigator.clipboard.writeText(CONTRACT_ADDRESS);
      copy.textContent = 'COPIED';
      copy.classList.add('copied');
      setTimeout(() => { copy.textContent = 'COPY'; copy.classList.remove('copied'); }, 1400);
    } catch { /* clipboard blocked */ }
  };
}

// ---------------- chaos possession ----------------
const $ = (id: string) => document.getElementById(id) as HTMLElement;
let possessing = false;
let chaosUntil = 0;
$('chaos-btn').onclick = () => sendWs({ t: 'chaos_claim' });
$('chaos-release').onclick = () => endPossession(true);
for (const b of document.querySelectorAll<HTMLButtonElement>('#chaos-hud button[data-act]')) {
  b.onclick = () => {
    if (!possessing) return;
    const input = $('chaos-text') as HTMLInputElement;
    sendWs({ t: 'chaos_act', kind: b.dataset.act as never, text: input.value.trim() || undefined });
    input.value = '';
    endPossession(false);
    toast('the chaos does your bidding, once.');
  };
}
store.onChaosGrant = (ok, until, error) => {
  if (!ok) { toast(error || 'the maze resists you'); return; }
  possessing = true;
  chaosUntil = until;
  $('chaos-hud').classList.add('open');
  ($('chaos-btn') as HTMLButtonElement).disabled = true;
  toast('you are the chaos. click the map to appear.');
};
function endPossession(tell: boolean) {
  if (tell && possessing) sendWs({ t: 'chaos_release' });
  possessing = false;
  $('chaos-hud').classList.remove('open');
  ($('chaos-btn') as HTMLButtonElement).disabled = false;
}
world.onGroundClick = (x, z) => {
  if (possessing) sendWs({ t: 'chaos_move', x: Math.floor(x), y: Math.floor(z) });
};

// ---------------- per-frame overlays ----------------
world.onFrame = () => {
  const now = performance.now();
  // agent name labels
  const seen = new Set<string>();
  for (const a of store.agents.values()) {
    if (a.state === 'dead') continue;
    seen.add(a.id);
    let el = labels.get(a.id);
    if (!el) {
      el = document.createElement('div');
      el.style.cssText = `position:absolute;font:10px Consolas,monospace;color:hsl(${a.hue},60%,72%);text-shadow:0 0 3px #000,0 0 2px #000;transform:translate(-50%,-100%);white-space:nowrap`;
      overlay.appendChild(el);
      labels.set(a.id, el);
    }
    el.textContent = a.name + (a.mindState === 'panicked' ? ' ⚠' : '');
    const p = world.agentHead(a.id);
    if (p && p.x > 230 && p.x < window.innerWidth && p.y > 0 && p.y < window.innerHeight) {
      el.style.display = '';
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
    } else el.style.display = 'none';
  }
  for (const [id, el] of labels) if (!seen.has(id)) { el.remove(); labels.delete(id); }
  // monster hazard marker (always visible so watchers can track it)
  const mp = world.monsterScreenPos();
  if (mp.x > 230 && mp.x < window.innerWidth && mp.y > 0 && mp.y < window.innerHeight) {
    monMarker.style.display = '';
    monMarker.style.left = `${mp.x}px`;
    monMarker.style.top = `${mp.y}px`;
  } else monMarker.style.display = 'none';

  // floating thoughts drift up + fade
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i]!;
    const age = now - f.born;
    const p = world.agentScreenPos(f.agentId);
    if (!p || age > 5000) {
      f.el.remove();
      floaters.splice(i, 1);
      continue;
    }
    f.el.style.left = `${p.x}px`;
    f.el.style.top = `${p.y - age * 0.02}px`;
    f.el.style.opacity = String(age > 3800 ? Math.max(0, (5000 - age) / 1200) : 1);
  }
  // chaos possession countdown
  if (possessing) {
    const left = Math.max(0, chaosUntil - Date.now());
    const s = Math.ceil(left / 1000);
    const el = document.getElementById('chaos-timer');
    if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (left <= 0) endPossession(false);
  }
};

// ---------------- ws helper ----------------
function sendWs(msg: unknown) {
  world.send(msg);
}
