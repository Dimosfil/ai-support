import { DatabaseSync, backup } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Explicit offline migration only. Never called by constructor/startup. */
export async function migrateDeliveryStorage(filename, backupFilename) {
  const source = resolve(filename), target = resolve(backupFilename);
  if (source === target || !existsSync(source) || existsSync(target)) throw new Error('invalid_backup_path');
  const db = new DatabaseSync(source);
  try {
    if (db.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('migration_requires_schema_v1');
    await backup(db, target);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('schema_changed');
      db.exec(readFileSync(new URL('./delivery-schema.sql', import.meta.url), 'utf8'));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { version: 2, backupPath: target };
  } finally { db.close(); }
}
