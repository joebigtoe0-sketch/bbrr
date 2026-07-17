import http from 'node:http';
import { config } from './config.js';
import { World } from './sim/world.js';
import { BrainScheduler } from './brain/scheduler.js';
import { WsHub } from './net/wsHub.js';
import { buildRest } from './net/rest.js';

const world = new World();
const scheduler = new BrainScheduler(world);
const app = buildRest(world, scheduler);
const server = http.createServer(app);
new WsHub(server, world);

world.start();
scheduler.start();

server.listen(config.PORT, () => {
  console.log(`[server] http+ws listening on :${config.PORT} (brains: ${config.BRAIN_MODE})`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[server] shutting down...');
  scheduler.stop();
  world.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

