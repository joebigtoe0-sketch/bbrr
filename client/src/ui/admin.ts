const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function log(msg: string) {
  const el = $('log');
  el.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n` + el.textContent;
}

function pw(): string {
  const v = $<HTMLInputElement>('pw').value;
  sessionStorage.setItem('backrooms-admin', v);
  return v;
}

async function post(path: string, body: unknown) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${pw()}`,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    log(res.ok ? `OK ${JSON.stringify(data)}` : `ERROR ${res.status} ${JSON.stringify(data)}`);
  } catch (e) {
    log(`FAILED: ${(e as Error).message}`);
  }
}

async function refreshAgents() {
  try {
    const res = await fetch('/api/agents');
    const data = await res.json();
    for (const selId of ['viral-agent', 'dbg-agent']) {
      const sel = $<HTMLSelectElement>(selId);
      const current = sel.value;
      sel.innerHTML = selId === 'viral-agent' ? '<option value="">auto</option>' : '';
      for (const a of data.living ?? []) {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.name;
        sel.appendChild(opt);
      }
      sel.value = current;
    }
  } catch {
    // ignore
  }
}

$<HTMLInputElement>('pw').value = sessionStorage.getItem('backrooms-admin') ?? '';

for (const btn of document.querySelectorAll<HTMLButtonElement>('button[data-event]')) {
  btn.onclick = () => {
    const type = btn.dataset.event!;
    const payload: Record<string, unknown> = {};
    if (type === 'viral_post') {
      const agentId = $<HTMLSelectElement>('viral-agent').value;
      if (agentId) payload.agentId = agentId;
      payload.magnitude = Number($<HTMLInputElement>('viral-mag').value) || 20;
    }
    if (type === 'buyback') payload.radiusChunks = 3;
    if (type === 'airdrop') payload.count = 3;
    post('/api/admin/event', { type, payload });
  };
}

$('teleport').onclick = () =>
  post('/api/admin/debug', {
    action: 'teleport_monster',
    x: Number($<HTMLInputElement>('tp-x').value) || 8,
    y: Number($<HTMLInputElement>('tp-y').value) || 8,
  });

$('force-stress').onclick = () =>
  post('/api/admin/debug', {
    action: 'force_stress',
    agentId: $<HTMLSelectElement>('dbg-agent').value,
    value: Number($<HTMLInputElement>('dbg-stress').value) || 90,
  });

$('force-deceiving').onclick = () =>
  post('/api/admin/debug', {
    action: 'force_deceiving',
    agentId: $<HTMLSelectElement>('dbg-agent').value,
    value: 1,
  });

refreshAgents();
setInterval(refreshAgents, 10000);
