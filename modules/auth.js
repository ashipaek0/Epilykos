const basicAuth = require('express-basic-auth');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

let settingsPassword = process.env.SETTINGS_PASSWORD;
if (!settingsPassword) {
  settingsPassword = crypto.randomBytes(8).toString('hex');
  console.warn('⚠️  WARNING: No SETTINGS_PASSWORD provided in environment.');
  console.warn(`🔒  Using randomly generated password: ${settingsPassword}`);
}

const authMiddleware = basicAuth({
  users: { 'admin': settingsPassword },
  challenge: true,
  realm: 'Energy Dashboard Settings'
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, please try again later' }
});

const csrfProtection = (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    if (!req.headers['x-requested-with'] || req.headers['x-requested-with'] !== 'XMLHttpRequest') {
      return res.status(403).json({ error: 'CSRF protection: Missing X-Requested-With header' });
    }
  }
  next();
};

module.exports = { authMiddleware, authLimiter, csrfProtection };
