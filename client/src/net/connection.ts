import { ServerMsg } from '@backrooms/shared';
import type { ClientMsg } from '@backrooms/shared';
import type { WorldStore } from '../state/worldStore.js';

/** Reconnecting websocket that feeds the store. */
export class Connection {
  private ws: WebSocket | null = null;
  private closed = false;
  onOpen: () => void = () => {};

  constructor(private store: WorldStore) {}

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onopen = () => this.onOpen();
    this.ws.onmessage = (ev) => {
      try {
        const parsed = ServerMsg.safeParse(JSON.parse(ev.data));
        if (parsed.success) this.store.apply(parsed.data);
      } catch {
        // ignore malformed frames
      }
    };
    this.ws.onclose = () => {
      if (!this.closed) setTimeout(() => this.connect(), 2000);
    };
    this.ws.onerror = () => this.ws?.close();
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  dispose() {
    this.closed = true;
    this.ws?.close();
  }
}
