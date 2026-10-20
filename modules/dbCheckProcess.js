'use strict';
const Database = require('better-sqlite3');
let db, result;
try {
  db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
  db.pragma('trusted_schema = OFF');
  db.pragma('query_only = ON');
  result = { ok: true, rows: db.pragma('quick_check').map(row => String(Object.values(row)[0])) };
} catch (error) {
  result = { ok: false, error: error.message.slice(0, 512) };
} finally { if (db) db.close(); }
process.send(result, () => process.disconnect());
