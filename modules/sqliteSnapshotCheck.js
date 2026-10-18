'use strict';
const Database = require('better-sqlite3');
// SQLite's ordered declared-type rules, not an exact type-name comparison:
// https://www.sqlite.org/datatype3.html#determination_of_column_affinity
function affinity(type) {
  const name = type.toUpperCase();
  if (name.includes('INT')) return 'INTEGER';
  if (/CHAR|CLOB|TEXT/.test(name)) return 'TEXT';
  if (!name || name.includes('BLOB')) return 'BLOB';
  if (/REAL|FLOA|DOUB/.test(name)) return 'REAL';
  return 'NUMERIC';
}
let db, result;
try {
  db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
  db.pragma('trusted_schema = OFF');
  db.pragma('query_only = ON');
  const rows = db.pragma('quick_check');
  const ok = rows.length === 1 && rows[0].quick_check === 'ok';
  if (!ok) throw new Error('The database failed SQLite quick_check');
  if (process.argv[3] === 'restore') {
    const version = db.pragma('user_version', { simple: true });
    if (version !== 0) throw new Error('The backup declares an unsupported database format version');
    const tables = db.pragma('table_list');
    const required = {
      config: { columns: { key: 'TEXT', value: 'TEXT' }, key: ['key'] },
      metrics: { columns: { timestamp: 'INTEGER', metric: 'TEXT', value: 'REAL' }, key: ['timestamp', 'metric'] },
      latest_metrics: { columns: { metric: 'TEXT', value: 'REAL', timestamp: 'INTEGER' }, key: ['metric'] }
    };
    for (const [name, spec] of Object.entries(required)) {
      const table = tables.find(table => table.schema === 'main' && table.name === name);
      if (!table || table.type !== 'table') throw new Error(`Backup is missing required ordinary table ${name}`);
      const columns = db.pragma(`table_info("${name}")`);
      const keys = columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
      if (Object.keys(spec.columns).some(name => !columns.some(column => column.name === name)) || JSON.stringify(keys) !== JSON.stringify(spec.key)) {
        throw new Error(`Backup has incompatible columns or primary key in ${name}`);
      }
      for (const [field, expected] of Object.entries(spec.columns)) {
        if (affinity(columns.find(column => column.name === field).type) !== expected) {
          throw new Error(`Backup has incompatible type affinity in ${name}.${field}`);
        }
      }
    }
    const pageSize = db.pragma('page_size', { simple: true });
    const pages = db.pragma('page_count', { simple: true });
    result = { ok: true, bytes: pages * pageSize, page_size: pageSize, user_version: version };
  } else { result = { ok: true }; }
} catch (error) {
  result = { ok: false, error: error.message.slice(0, 512) };
} finally { if (db) db.close(); }

process.send(result, () => process.disconnect());
