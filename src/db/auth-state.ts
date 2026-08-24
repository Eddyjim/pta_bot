import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '@whiskeysockets/baileys';
import { db } from './index.js';

/**
 * Baileys ships `useMultiFileAuthState`, which scatters creds + signal keys across a
 * directory. Putting them in SQLite instead means the nightly encrypted snapshot covers
 * the pairing too — otherwise losing the volume means re-pairing by QR against the
 * physical prepaid handset, which is the one recovery step you cannot do remotely.
 */
export function useSQLiteAuthState(): {
  state: AuthenticationState;
  saveCreds: () => void;
} {
  const read = db.prepare('SELECT value FROM auth_state WHERE name = ?');
  const write = db.prepare(
    'INSERT INTO auth_state (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
  );
  const drop = db.prepare('DELETE FROM auth_state WHERE name = ?');

  const get = <T>(name: string): T | null => {
    const row = read.get(name) as { value: string } | undefined;
    return row ? JSON.parse(row.value, BufferJSON.reviver) : null;
  };
  const set = (name: string, value: unknown): void => {
    if (value === null || value === undefined) drop.run(name);
    else write.run(name, JSON.stringify(value, BufferJSON.replacer));
  };

  const creds: AuthenticationCreds = get<AuthenticationCreds>('creds') ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const out: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            let value = get<any>(`${type}-${id}`);
            // app-state-sync-keys must be rehydrated into their protobuf type.
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            if (value) out[id] = value;
          }
          return out;
        },
        set: async (data) => {
          // Single transaction: signal key writes are hot and come in batches.
          db.transaction(() => {
            for (const category in data) {
              for (const id in data[category as keyof SignalDataTypeMap]) {
                const value = (data as any)[category][id];
                set(`${category}-${id}`, value);
              }
            }
          })();
        },
      },
    },
    saveCreds: () => set('creds', creds),
  };
}
