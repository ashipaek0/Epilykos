'use strict';
/**
 * express-session store backed by the app's own SQLite database, so a signed-in
 * session survives a restart (the default MemoryStore drops every session when
 * the process exits, despite the persistent session secret). No extra
 * dependency: it reuses better-sqlite3 through modules/database.getDb().
 *
 * The DB is opened after the session middleware is created, so the table is
 * made lazily on first use (by then initializeDatabase() has run). Expired
 * rows are pruned on startup and hourly; get() also ignores an expired row.
 */
const { getDb } = require('./database');

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function createSessionStore(session) {
  const Store = session.Store;

  class SqliteStore extends Store {
    constructor() {
      super();
      this._ready = false;
      this._timer = null;
    }

    _db() {
      const db = getDb(); // throws until the DB is initialized; callers handle it
      if (!this._ready) {
        db.exec(`CREATE TABLE IF NOT EXISTS sessions (
          sid TEXT PRIMARY KEY,
          expires INTEGER NOT NULL,
          data TEXT NOT NULL
        )`);
        db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
        this._ready = true;
        if (!this._timer) {
          this._timer = setInterval(() => {
            try { getDb().prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now()); } catch (_) {}
          }, PRUNE_INTERVAL_MS);
          if (this._timer.unref) this._timer.unref();
        }
      }
      return db;
    }

    _expiry(sess) {
      const ms = sess && sess.cookie && sess.cookie.maxAge;
      return Date.now() + (Number.isFinite(ms) ? ms : DEFAULT_TTL_MS);
    }

    get(sid, cb) {
      try {
        const row = this._db().prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
        if (!row) return cb(null, null);
        if (row.expires <= Date.now()) { this.destroy(sid, () => {}); return cb(null, null); }
        return cb(null, JSON.parse(row.data));
      } catch (err) { return cb(err); }
    }

    set(sid, sess, cb) {
      try {
        this._db().prepare('INSERT OR REPLACE INTO sessions (sid, expires, data) VALUES (?, ?, ?)')
          .run(sid, this._expiry(sess), JSON.stringify(sess));
        return cb && cb(null);
      } catch (err) { return cb && cb(err); }
    }

    touch(sid, sess, cb) {
      try {
        this._db().prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(this._expiry(sess), sid);
        return cb && cb(null);
      } catch (err) { return cb && cb(err); }
    }

    destroy(sid, cb) {
      try {
        this._db().prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return cb && cb(null);
      } catch (err) { return cb && cb(err); }
    }

    clear(cb) {
      try { this._db().prepare('DELETE FROM sessions').run(); return cb && cb(null); }
      catch (err) { return cb && cb(err); }
    }

    length(cb) {
      try { const n = this._db().prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires > ?').get(Date.now()).n; return cb(null, n); }
      catch (err) { return cb(err); }
    }
  }

  return new SqliteStore();
}

module.exports = { createSessionStore };
