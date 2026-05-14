const crypto = require('crypto');

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
  // For API requests, return 401 JSON; for HTML pages, redirect to login
  if (req.xhr || req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'Authentication required' });
  } else {
    res.redirect('/login');
  }
}

// Rate limiter for login attempts
const rateLimit = require('express-rate-limit');
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again later' }
});

// CSRF protection (unchanged)
const csrfProtection = (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    if (!req.headers['x-requested-with'] || req.headers['x-requested-with'] !== 'XMLHttpRequest') {
      return res.status(403).json({ error: 'CSRF protection: Missing X-Requested-With header' });
    }
  }
  next();
};

module.exports = { isAuthenticated, authLimiter, csrfProtection, settingsPassword };
