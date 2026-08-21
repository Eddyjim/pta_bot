import 'node:process';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  // Optional at boot, unlike everything else req()'d here: on first run there IS no
  // group JID yet — the documented flow is start the bot, let it log the JID once a
  // group message arrives, then set this and restart. An empty string never matches a
  // real JID, so router.ts's `chat !== config.groupJid` check safely ignores every
  // group until this is set.
  groupJid: process.env.GROUP_JID ?? '',
  adminJid: req('ADMIN_JID'),
  consentMode: (process.env.CONSENT_MODE ?? 'optin') as 'optin' | 'optout',
  anthropicKey: req('ANTHROPIC_API_KEY'),
  extractionModel: process.env.EXTRACTION_MODEL ?? 'claude-haiku-4-5-20251001',
  answerModel: process.env.ANSWER_MODEL ?? 'claude-haiku-4-5-20251001',
  dbPath: process.env.DB_PATH ?? './pta.db',
  tz: 'America/Bogota',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  rawRetentionDays: Number(process.env.RAW_RETENTION_DAYS ?? 7),
  draftTtlHours: Number(process.env.DRAFT_TTL_HOURS ?? 12),
  answerCooldownSeconds: Number(process.env.ANSWER_COOLDOWN_SECONDS ?? 60),
  optInKeyword: '#acepto',
  optOutKeyword: '#salir',
} as const;
