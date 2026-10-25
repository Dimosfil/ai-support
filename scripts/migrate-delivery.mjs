import { migrateDeliveryStorage } from '../src/storage/migrate-delivery.mjs';

const [filename, backupFilename, ...extra] = process.argv.slice(2);
if (!filename || !backupFilename || extra.length) {
  console.error('Usage (stop the app first): npm run delivery:migrate -- <database> <new-backup-file>');
  process.exitCode = 1;
} else {
  try {
    await migrateDeliveryStorage(filename, backupFilename);
    console.log('Support storage upgraded to v2; a consistent v1 backup was created.');
  } catch {
    console.error('Delivery migration failed. Check schema v1, source path and a new writable backup path.');
    process.exitCode = 1;
  }
}
