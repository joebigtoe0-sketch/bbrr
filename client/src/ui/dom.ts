import { OBJECTIVE_LABELS, OBJECTIVES } from '@backrooms/shared';
import type { Agent, Objective } from '@backrooms/shared';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- toasts ----------
export function toast(text: string, ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ---------- sidebar ----------
export interface SidebarCallbacks {
  onAgentClick: (id: string) => void;
}

export function renderAgentList(agents: Agent[], tunedId: string | null, cb: SidebarCallbacks) {
  const list = $('agent-list');
  list.innerHTML = '';
  const sorted = [...agents].sort((a, b) => b.attention - a.attention);
  for (const a of sorted) {
    const row = document.createElement('div');
    row.className = 'agent-row' + (a.id === tunedId ? ' tuned' : '');
    const color = `hsl(${a.hue}, 65%, 65%)`;
    row.innerHTML = `
      <div class="name" style="color:${color}">${esc(a.name)} ${a.mindState === 'panicked' ? '⚠' : ''}${a.state === 'dead' ? '✝' : ''}</div>
      <div class="obj">${esc(OBJECTIVE_LABELS[a.objective])} · ${a.state}</div>
      <div class="bar stress"><div style="width:${a.stress}%"></div></div>
      <div class="bar attention"><div style="width:${a.attention}%"></div></div>`;
    row.onclick = () => cb.onAgentClick(a.id);
    list.appendChild(row);
  }
  if (sorted.length === 0) {
    list.innerHTML = '<div class="death-row">nobody is inside. yet.</div>';
  }
}

export async function refreshDeaths() {
  try {
    const res = await fetch('/api/agents');
    const data = await res.json();
    const list = $('death-list');
    list.innerHTML = '';
    for (const d of data.recentDeaths ?? []) {
      const row = document.createElement('div');
      row.className = 'death-row';
      row.textContent = `${d.name} — ${d.cause ?? 'unknown'}`;
      list.appendChild(row);
    }
  } catch {
    // server restarting; try again next cycle
  }
}

// ---------- spawn modal ----------
export function initSpawnModal(onSpawned: (agentId: string) => void) {
  const modal = $('spawn-modal');
  const sel = $<HTMLSelectElement>('spawn-objective');
  for (const o of OBJECTIVES) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = OBJECTIVE_LABELS[o as Objective];
    sel.appendChild(opt);
  }
  $('spawn-btn').onclick = () => {
    $('spawn-error').textContent = '';
    modal.classList.add('open');
  };
  $('spawn-cancel').onclick = () => modal.classList.remove('open');
  $('spawn-confirm').onclick = async () => {
    const name = $<HTMLInputElement>('spawn-name').value.trim();
    const objective = sel.value;
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objective, ...(name ? { name } : {}) }),
      });
      const data = await res.json();
      if (res.status === 201) {
        modal.classList.remove('open');
        toast(`${data.name} woke up on the damp carpet.`);
        onSpawned(data.agentId);
      } else if (data.error === 'world_full') {
        $('spawn-error').textContent = 'The maze is full. Someone must die first.';
      } else if (data.error === 'rate_limited') {
        $('spawn-error').textContent = 'The maze refuses more of your offerings for now.';
      } else {
        $('spawn-error').textContent = data.detail ?? data.error ?? 'something went wrong';
      }
    } catch {
      $('spawn-error').textContent = 'could not reach the server';
    }
  };
}

// ---------- reader panel ----------
let typeTimer: ReturnType<typeof setInterval> | null = null;

export function openReader(title: string, lines: string[], typeOn = true) {
  const panel = $('reader');
  const linesEl = $('reader-lines');
  $('reader-title').textContent = title;
  panel.classList.add('open');
  if (typeTimer) clearInterval(typeTimer);
  if (!typeOn) {
    linesEl.textContent = lines.join('\n');
    return;
  }
  linesEl.textContent = '';
  const full = lines.join('\n');
  let i = 0;
  typeTimer = setInterval(() => {
    i += 3;
    linesEl.textContent = full.slice(0, i) + (i < full.length ? '█' : '');
    if (i >= full.length) {
      linesEl.textContent = full;
      if (typeTimer) clearInterval(typeTimer);
    }
  }, 16);
}

export function closeReader() {
  $('reader').classList.remove('open');
  if (typeTimer) clearInterval(typeTimer);
}

export function initReader() {
  $('reader-close').onclick = closeReader;
}

// ---------- tune-in overlay ----------
export function playTuneIn(agentName: string, onDone: () => void) {
  const el = $('tunein');
  const freq = $('tunein-freq');
  el.classList.add('open', 'static');
  const start = 87.4 + Math.random() * 3;
  const end = 89 + Math.random() * 19;
  const t0 = performance.now();
  const dur = 1200;
  const step = (t: number) => {
    const p = Math.min(1, (t - t0) / dur);
    const f = start + (end - start) * p;
    freq.textContent = `${f.toFixed(1)} MHz ${p < 1 ? '· searching' : `· LOCKED: ${agentName}`}`;
    if (p < 1) requestAnimationFrame(step);
    else {
      el.classList.remove('static');
      setTimeout(() => el.classList.remove('open'), 900);
      onDone();
    }
  };
  requestAnimationFrame(step);
}

export function hideTuneIn() {
  $('tunein').classList.remove('open', 'static');
}

function esc(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
