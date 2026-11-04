const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');

const PASSWORD_FILE = path.join(__dirname, '..', 'data', 'settings-password');

let storedSalt = null;
let storedHash = null;

function hashPasswordWithSalt(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

const passwordEnvManaged = !!process.env.SETTINGS_PASSWORD;

if (passwordEnvManaged) {
  storedSalt = crypto.randomBytes(16).toString('hex');
  storedHash = hashPasswordWithSalt(process.env.SETTINGS_PASSWORD, storedSalt);
  // Still accepted, so an existing install keeps working; the wizard needs 12 for a new one.
  if (process.env.SETTINGS_PASSWORD.length < 12) {
    console.warn('⚠️  SETTINGS_PASSWORD is shorter than 12 characters. Use at least 12: remote access refuses a shorter admin password.');
  }
} else {
  try {
    if (fs.existsSync(PASSWORD_FILE)) {
      const content = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
      if (!content) throw new Error('Empty password file');
      if (content.includes(':')) {
        const [s, h] = content.split(':');
        storedSalt = s;
        storedHash = h;
      } else {
        // Migration: migrate legacy plaintext password to salted hash
        storedSalt = crypto.randomBytes(16).toString('hex');
        storedHash = hashPasswordWithSalt(content, storedSalt);
        fs.mkdirSync(path.dirname(PASSWORD_FILE), { recursive: true });
        fs.writeFileSync(PASSWORD_FILE, `${storedSalt}:${storedHash}`, { mode: 0o600 });
        console.log('🔒 Migrated settings password from plain text to salted hash');
      }
    } else {
      const initPw = crypto.randomBytes(8).toString('hex');
      storedSalt = crypto.randomBytes(16).toString('hex');
      storedHash = hashPasswordWithSalt(initPw, storedSalt);
      fs.mkdirSync(path.dirname(PASSWORD_FILE), { recursive: true });
      fs.writeFileSync(PASSWORD_FILE, `${storedSalt}:${storedHash}`, { mode: 0o600 });
      console.warn('⚠️  WARNING: No SETTINGS_PASSWORD provided in environment.');
      console.warn(`🔒  A random password has been generated and saved securely to data/settings-password`);
    }
  } catch (err) {
    const fallbackPw = crypto.randomBytes(8).toString('hex');
    storedSalt = crypto.randomBytes(16).toString('hex');
    storedHash = hashPasswordWithSalt(fallbackPw, storedSalt);
    console.error('Failed to persist settings password:', err.message);
  }
}

// A longer "password" costs nothing extra to check but is never a real one.
const MAX_PASSWORD_LENGTH = 1024;

function verifyPassword(inputPassword) {
  if (typeof inputPassword !== 'string' || inputPassword.length > MAX_PASSWORD_LENGTH || !storedSalt || !storedHash) return false;
  const computedHash = hashPasswordWithSalt(inputPassword, storedSalt);
  try {
    return crypto.timingSafeEqual(Buffer.from(computedHash, 'hex'), Buffer.from(storedHash, 'hex'));
  } catch (_) {
    return false;
  }
}

/**
 * The same check without blocking the server: scrypt takes ~50 ms (several
 * hundred on a Raspberry Pi), and the synchronous version stops every other
 * request, the live dashboard included, for that long on each attempt.
 */
function verifyPasswordAsync(inputPassword) {
  if (typeof inputPassword !== 'string' || inputPassword.length > MAX_PASSWORD_LENGTH || !storedSalt || !storedHash) return Promise.resolve(false);
  const salt = storedSalt, expected = storedHash;
  return new Promise(resolve => {
    crypto.scrypt(inputPassword, salt, 64, (err, key) => {
      if (err) return resolve(false);
      try { resolve(crypto.timingSafeEqual(key, Buffer.from(expected, 'hex'))); } catch (_) { resolve(false); }
    });
  });
}

function setSettingsPassword(pw) {
  if (passwordEnvManaged) {
    const err = new Error('Password is managed by environment');
    err.status = 403;
    throw err;
  }
  const newSalt = crypto.randomBytes(16).toString('hex');
  const newHash = hashPasswordWithSalt(String(pw), newSalt);
  fs.mkdirSync(path.dirname(PASSWORD_FILE), { recursive: true });
  fs.writeFileSync(PASSWORD_FILE, `${newSalt}:${newHash}`, { mode: 0o600 });
  storedSalt = newSalt;
  storedHash = newHash;
  return true;
}

// Middleware to check if user is authenticated
function isAuthenticated(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  if (req.xhr || req.originalUrl.startsWith('/api/')) {
    res.status(401).json({ error: 'Authentication required' });
  } else {
    res.redirect('/login');
  }
}

// Rate limit for every route that checks the admin password: 10 a minute per
// client address (the address is what Express reports; see modules/trustProxy.js
// for why a forwarded address is only believed from a trusted proxy), and
// GLOBAL_LIMIT a minute from all addresses together, so a spread of addresses
// cannot turn the limit into nothing.
const perAddressLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  message: { error: 'Too many login attempts, please try again later' }
});
const GLOBAL_WINDOW_MS = 60 * 1000;
const GLOBAL_LIMIT = 30;
let globalAttempts = [];
function resetLoginThrottle() { globalAttempts = []; }
function globalLoginGuard(req, res, next) {
  const now = Date.now();
  globalAttempts = globalAttempts.filter(t => now - t < GLOBAL_WINDOW_MS);
  if (globalAttempts.length >= GLOBAL_LIMIT) {
    const wait = Math.max(1, Math.ceil((globalAttempts[0] + GLOBAL_WINDOW_MS - now) / 1000));
    res.set('Retry-After', String(wait));
    return res.status(429).json({ error: 'Too many login attempts, please try again later' });
  }
  globalAttempts.push(now);
  next();
}
function loginLimiter(req, res, next) {
  perAddressLimiter(req, res, err => (err ? next(err) : globalLoginGuard(req, res, next)));
}

// Shared session-bound CSRF guard (also used by HTTP fixtures).
const { csrfProtection } = require('./csrfProtection');

module.exports = {
  isAuthenticated,
  loginLimiter,
  csrfProtection,
  passwordEnvManaged,
  verifyPassword,
  verifyPasswordAsync,
  setSettingsPassword,
  resetLoginThrottle,
  MAX_PASSWORD_LENGTH
};

