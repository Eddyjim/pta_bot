import { openBotDb, botHeartbeat } from './db/index.js';
import { GroupRegistry } from './groups.js';
import { connect, shutdown } from './whatsapp/connection.js';
import { attachRouter } from './whatsapp/router.js';
import { startScheduler } from './scheduler/index.js';
import { config } from './config.js';
import { log } from './logger.js';

let schedulerStarted = false;

async function main(): Promise<void> {
  const botDb = openBotDb(config.dbDir);
  const registry = new GroupRegistry(botDb, config.dbDir);
  registry.load();

  await connect(botDb, (sock) => {
    attachRouter(sock, botDb, registry);
    // Reconnects re-fire onReady; cron must only be registered once.
    if (!schedulerStarted) { startScheduler(registry); schedulerStarted = true; }
  });

  // Catches the case where the process is alive but the socket is quietly dead —
  // which happens, and is otherwise invisible from outside.
  setInterval(() => botHeartbeat(botDb, true), 5 * 60_000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { log.info({ sig }, 'shutting down'); shutdown(); process.exit(0); });
}
process.on('unhandledRejection', (e) => log.error({ e }, 'unhandled rejection'));

main().catch((e) => { log.fatal({ e }, 'fatal'); process.exit(1); });
