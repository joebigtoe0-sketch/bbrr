import http from 'node:http';
import { setDefaultAutoSelectFamily } from 'node:net';
import { config } from './config.js';

// Happy Eyeballs: without this, Windows boxes with broken IPv6 routes stall
// 20-30s on the first connection to api.openai.com (seen as brain timeouts)
setDefaultAutoSelectFamily(true);
import { World } from './sim/world.js';
import { BrainScheduler } from './brain/scheduler.js';
import { MazeVoice } from './brain/mazeVoice.js';
import { WsHub } from './net/wsHub.js';
import { buildRest } from './net/rest.js';
import { XClient } from './social/x.js';

const world = new World();
const scheduler = new BrainScheduler(world);
const voice = new MazeVoice(world);
const x = new XClient();
const app = buildRest(world, scheduler, x);
const server = http.createServer(app);
new WsHub(server, world);

world.start();
scheduler.start();
voice.start();
x.start(world);

server.listen(config.PORT, () => {
  console.log(`[server] http+ws listening on :${config.PORT} (brains: ${config.BRAIN_MODE})`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[server] shutting down...');
  scheduler.stop();
  voice.stop();
  x.stop();
  world.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

