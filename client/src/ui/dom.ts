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
      <div class="bar attention"><div style="width:${a.attention}%"></div></div>
      <div class="bar battery"><div style="width:${a.battery}%"></div></div>
      <div class="bar energy"><div style="width:${a.energy}%"></div></div>`;
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

// ---------- right panel: LOG / TWEETS / RECORDS ----------
type RightTab = 'log' | 'tweets' | 'records';
let rightTab: RightTab | null = null;
const logEntries: { t: string; text: string; cls: string }[] = [];

export function initRightPanel() {
  for (const tab of ['log', 'tweets', 'records'] as RightTab[]) {
    $(`btn-${tab}`).onclick = () => toggleRightTab(tab);
  }
  $('right-close').onclick = () => {
    rightTab = null;
    $('right-panel').classList.remove('open');
    syncPanelButtons();
  };
  setInterval(() => {
    if (rightTab === 'tweets') void refreshTweets();
    if (rightTab === 'records') void refreshRecords();
  }, 25000);
}

function syncPanelButtons() {
  for (const tab of ['log', 'tweets', 'records'] as RightTab[]) {
    $(`btn-${tab}`).classList.toggle('active', rightTab === tab);
  }
}

export function toggleRightTab(tab: RightTab) {
  if (rightTab === tab) {
    rightTab = null;
    $('right-panel').classList.remove('open');
  } else {
    rightTab = tab;
    $('right-panel').classList.add('open');
    $('right-title').textContent = tab.toUpperCase();
    renderRight();
  }
  syncPanelButtons();
}

function renderRight() {
  if (rightTab === 'log') renderLog();
  else if (rightTab === 'tweets') void refreshTweets();
  else if (rightTab === 'records') void refreshRecords();
}

/** everything that happens in the maze, newest first */
export function appendLog(text: string, cls = '') {
  const t = new Date().toLocaleTimeString([], { hour12: false });
  logEntries.unshift({ t, text, cls });
  if (logEntries.length > 250) logEntries.pop();
  if (rightTab === 'log') renderLog();
}

function renderLog() {
  $('right-content').innerHTML = logEntries
    .map((e) => `<div class="log-line ${e.cls}"><span class="t">${e.t}</span>${esc(e.text)}</div>`)
    .join('');
}

export async function refreshTweets() {
  try {
    const res = await fetch('/api/tweets');
    const data = await res.json();
    if (rightTab !== 'tweets') return;
    $('right-content').innerHTML = (data.tweets ?? [])
      .map(
        (tw: { text: string; kind: string; created_at: number }) =>
          `<div class="tweet-card">${esc(tw.text)}<div class="meta">@the_backrooms · ${tw.kind} · ${new Date(tw.created_at).toLocaleTimeString([], { hour12: false })}</div></div>`,
      )
      .join('') || '<div class="log-line">the maze has said nothing yet.</div>';
  } catch {
    // server restarting
  }
}

export async function refreshRecords() {
  try {
    const res = await fetch('/api/records');
    const data = await res.json();
    if (rightTab !== 'records') return;
    $('right-content').innerHTML = (data.records ?? [])
      .map((r: { name: string; objective: string; story: string; born_at: number; died_at: number; cause: string | null }) => {
        const mins = Math.max(1, Math.round((r.died_at - r.born_at) / 60000));
        return `<div class="record-card"><div class="rname">CASE FILE // ${esc(r.name)}</div><div class="rmeta">${esc(r.objective)} · survived ${mins} min · ${esc(r.cause ?? 'unknown')}</div>${esc(r.story)}</div>`;
      })
      .join('') || '<div class="log-line">no case files yet. the maze is patient.</div>';
  } catch {
    // server restarting
  }
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
