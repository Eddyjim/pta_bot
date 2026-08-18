import pino from 'pino';
import { config } from './config.js';

export const log = pino({
  level: config.logLevel,
  // Never let a phone number reach the logs.
  redact: { paths: ['*.jid', '*.remoteJid', 'jid', 'remoteJid'], censor: '[jid]' },
});
