const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');

const PASSWORD_FILE = path.join(__dirname, '..', 'data', 'settings-password');

let settingsPassword = process.env.SETTINGS_PASSWORD;
if (!settingsPassword) {
  try {
    if (fs.existsSync(PASSWORD_FILE)) {
      settingsPassword = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
      if (!settingsPassword) throw new Error('Empty password file');
    } else {
      settingsPassword = crypto.randomBytes(8).toString('hex');
      fs.mkdirSync(path.dirname(PASSWORD_FILE), { recursive: true });
      fs.writeFileSync(PASSWORD_FILE, settingsPassword, { mode: 0o600 });
    }
  } catch (err) {
    settingsPassword = crypto.randomBytes(8).toString('hex');
    console.error('Failed to persist settings password:', err.message);
  }
  console.warn('⚠️  WARNING: No SETTINGS_PASSWORD provided in environment.');
  console.warn('🔒  A random password has been generated and saved to data/settings-password');
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

// Rate limiter for login attempts only (10 per minute)
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again later' }
});

// CSRF protection (skip for login endpoint)
const csrfProtection = (req, res, next) => {
  // Skip CSRF for login endpoint and PVOutput webhook (called by external servers)
  if (req.originalUrl === '/api/login' || req.originalUrl.startsWith('/api/pvoutput/webhook')) {
    return next();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    if (!req.headers['x-requested-with'] || req.headers['x-requested-with'] !== 'XMLHttpRequest') {
      return res.status(403).json({ error: 'CSRF protection: Missing X-Requested-With header' });
    }
  }
  next();
};

module.exports = { isAuthenticated, loginLimiter, csrfProtection, settingsPassword };
