'use strict';
const fs = require('node:fs');
let db, result;
try {
  // Environment must be installed before loading the native SQLite library.
  const scratch = process.env.SQLITE_TMPDIR;
  const held = fs.fstatSync(4).isFile();
  const Database = require('better-sqlite3');
  db = new Database(':memory:');
  db.pragma('temp_store = FILE');
  db.pragma('temp.cache_size = -256');
  db.exec('CREATE TEMP TABLE spill(payload BLOB); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100) INSERT INTO spill SELECT zeroblob(131072) FROM n');
  const tempPaths = fs.readdirSync('/proc/self/fd').flatMap(name => { try { return [fs.readlinkSync('/proc/self/fd/' + name)]; } catch (_) { return []; } });
  result = { ok: true, scratch, held, tempPaths };
} catch (error) { result = { ok: false, error: error.message }; }
finally { try { db?.close(); } catch (_) {} }
process.send(result, () => process.disconnect());
