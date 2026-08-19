import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import type { WASocket } from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { useSQLiteAuthState } from '../db/auth-state.js';
import { heartbeat } from '../db/index.js';
import { log } from '../logger.js';

let sock: WASocket | null = null;
let attempt = 0;
let stopped = false;

export const getSock = (): WASocket => {
  if (!sock) throw new Error('socket not connected');
  return sock;
};

/** Full jitter exponential backoff, capped at 5 min. */
function backoffMs(n: number): number {
  return Math.random() * Math.min(300_000, 1_000 * 2 ** Math.min(n, 8));
}

export async function connect(
  onReady: (sock: WASocket) => void,
): Promise<void> {
  const { state, saveCreds } = useSQLiteAuthState();
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    // We drive presence explicitly; announcing "online" constantly looks botlike.
    markOnlineOnConnect: false,
    syncFullHistory: false,
    logger: log.child({ mod: 'baileys' }) as any,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      log.warn('pairing required - scan with the bot handset');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      attempt = 0;
      heartbeat(true);
      log.info('connected');
      onReady(sock!);
    }

    if (connection === 'close') {
      heartbeat(false);
      const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;

      // TERMINAL. The pairing was revoked on the phone. Retrying looks like abuse
      // and will not work: recovery needs physical access to scan a new QR.
      if (code === DisconnectReason.loggedOut) {
        log.fatal('logged out - credentials revoked, re-pair required');
        process.exit(1);
      }

      // Someone linked this number elsewhere, or a second instance is running.
      // Both are operator errors and both present as random dropouts if you retry.
      if (code === DisconnectReason.connectionReplaced) {
        log.fatal('connection replaced - another instance is using these creds');
        process.exit(1);
      }

      if (stopped) return;

      const delay = backoffMs(attempt++);
      log.warn({ code, attempt, delay }, 'disconnected, reconnecting');
      setTimeout(() => connect(onReady).catch(e => log.error(e, 'reconnect failed')), delay);
    }
  });
}

export function shutdown(): void {
  stopped = true;
  try { sock?.end(undefined); } catch { /* already gone */ }
}
