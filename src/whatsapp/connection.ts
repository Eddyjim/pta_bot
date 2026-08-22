import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import type { WASocket } from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { useSQLiteAuthState } from '../db/auth-state.js';
import { heartbeat } from '../db/index.js';
import { log } from '../logger.js';
import { config } from '../config.js';

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

  // Alternative to the QR when scanning isn't practical: type this code into the
  // handset instead (WhatsApp > Linked Devices > Link with phone number). Self-guards
  // on `registered` the same way the QR flow does — a no-op on every run after pairing
  // actually succeeds, so PAIRING_NUMBER is harmless to leave set afterward.
  if (config.pairingNumber && !sock.authState.creds.registered) {
    sock.requestPairingCode(config.pairingNumber)
      .then(code => log.warn({ code }, 'pairing code - enter this on the bot handset'))
      .catch(e => log.error({ e }, 'failed to request pairing code'));
  }

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
      //
      // Exit code 78 (not the generic 1 main.ts uses for unexpected fatals) is
      // deliberate: systemd's Restart=always can't otherwise tell "don't ever retry
      // this" apart from "retry me, this was transient" — it previously restarted
      // through both identically. RestartPreventExitStatus=78 in the systemd units
      // makes it actually stop here instead of hammering WhatsApp's servers with
      // fresh registration attempts every RestartSec.
      if (code === DisconnectReason.loggedOut) {
        log.fatal('logged out - credentials revoked, re-pair required');
        process.exit(78);
      }

      // Someone linked this number elsewhere, or a second instance is running.
      // Both are operator errors and both present as random dropouts if you retry.
      if (code === DisconnectReason.connectionReplaced) {
        log.fatal('connection replaced - another instance is using these creds');
        process.exit(78);
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
