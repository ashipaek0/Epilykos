'use strict';
const Database = require('better-sqlite3');
let db, result;
try {
  db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
  const rows = db.pragma('quick_check');
  const ok = rows.length === 1 && rows[0].quick_check === 'ok';
  result = { ok, error: ok ? undefined : 'Backup failed SQLite quick_check' };
} catch (error) {
  result = { ok: false, error: error.message.slice(0, 512) };
} finally { if (db) db.close(); }

process.send(result, () => process.disconnect());
