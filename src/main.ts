import { migrate, heartbeat } from './db/index.js';
import { connect, shutdown } from './whatsapp/connection.js';
import { attachRouter } from './whatsapp/router.js';
import { startScheduler } from './scheduler/index.js';
import { log } from './logger.js';

let schedulerStarted = false;

async function main(): Promise<void> {
  migrate();

  await connect((sock) => {
    attachRouter(sock);
    // Reconnects re-fire onReady; cron must only be registered once.
    if (!schedulerStarted) { startScheduler(); schedulerStarted = true; }
  });

  // Catches the case where the process is alive but the socket is quietly dead —
  // which happens, and is otherwise invisible from outside.
  setInterval(() => heartbeat(true), 5 * 60_000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { log.info({ sig }, 'shutting down'); shutdown(); process.exit(0); });
}
process.on('unhandledRejection', (e) => log.error({ e }, 'unhandled rejection'));

main().catch((e) => { log.fatal({ e }, 'fatal'); process.exit(1); });
