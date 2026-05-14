const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

let settingsPassword = process.env.SETTINGS_PASSWORD;
if (!settingsPassword) {
  settingsPassword = crypto.randomBytes(8).toString('hex');
  console.warn('⚠️  WARNING: No SETTINGS_PASSWORD provided in environment.');
  console.warn(`🔒  Using randomly generated password: ${settingsPassword}`);
}

// Middleware to check if user is authenticated
function isAuthenticated(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  if (req.xhr || req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'Authentication required' });
  } else {
    res.redirect('/login');
  }
}

// Rate limiter for login attempts
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again later' }
});

// CSRF protection (skip for login endpoint)
const csrfProtection = (req, res, next) => {
  // Skip CSRF for login endpoint
  if (req.path === '/api/login') {
    return next();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    if (!req.headers['x-requested-with'] || req.headers['x-requested-with'] !== 'XMLHttpRequest') {
      return res.status(403).json({ error: 'CSRF protection: Missing X-Requested-With header' });
    }
  }
  next();
};

module.exports = { isAuthenticated, authLimiter, csrfProtection, settingsPassword };
