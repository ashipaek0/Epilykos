/**
 * Settings → Security → Two-step sign-in. Mounted behind isAuthenticated.
 *
 * Turning it on and off, and making new recovery codes, always re-ask for
 * the password; turning it off and making new codes also need a current code.
 */
const express = require('express');
const QRCode = require('qrcode');
const { logger } = require('../modules/logger');
const { loginLimiter, verifyPassword } = require('../modules/sessionAuth');
const twoStep = require('../modules/twoStep');

const router = express.Router();
const SETUP_MS = 10 * 60 * 1000;

function needPassword(req, res) {
  const password = req.body && req.body.password;
  if (typeof password === 'string' && verifyPassword(password)) return true;
  logger.warn('Two-step settings: wrong password');
  res.status(403).json({ error: 'That password is not right.' });
  return false;
}

router.get('/status', (req, res) => {
  res.json({ ...twoStep.status(), resetByEnv: /^(1|true|yes)$/i.test(process.env.RESET_TWO_STEP || '') });
});

// Step 1: password in, a new secret and its QR code out. Nothing is saved
// until /enable sees a code from the app.
router.post('/begin', loginLimiter, async (req, res) => {
  if (twoStep.isEnabled()) return res.status(409).json({ error: 'Two-step sign-in is already on.' });
  if (!needPassword(req, res)) return;
  try {
    const secret = twoStep.generateSecret();
    const uri = twoStep.otpauthUri(secret, { account: req.hostname || 'dashboard' });
    req.session.twoStepSetup = { secret, at: Date.now() };
    res.json({ secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 240 }) });
  } catch (err) {
    logger.error('Two-step setup failed:', err.message);
    res.status(500).json({ error: 'Could not start two-step setup.' });
  }
});

// Step 2: a code from the app proves it was scanned; the recovery codes are
// returned here, once.
router.post('/enable', loginLimiter, (req, res) => {
  const setup = req.session && req.session.twoStepSetup;
  if (!setup || Date.now() - setup.at > SETUP_MS) {
    if (req.session) delete req.session.twoStepSetup;
    return res.status(400).json({ error: 'The setup timed out. Start again.' });
  }
  const recoveryCodes = twoStep.enable(setup.secret, req.body && req.body.code);
  if (!recoveryCodes) {
    return res.status(400).json({ error: 'That code did not match. Check the phone\'s clock and try the next code.', serverTime: new Date().toISOString() });
  }
  delete req.session.twoStepSetup;
  logger.info('Two-step sign-in turned on');
  res.json({ success: true, recoveryCodes });
});

router.post('/disable', loginLimiter, (req, res) => {
  if (!twoStep.isEnabled()) return res.json({ success: true });
  if (!needPassword(req, res)) return;
  if (!twoStep.check(req.body && req.body.code).ok) {
    return res.status(403).json({ error: 'That code did not work. Use a code from the app or a recovery code.', serverTime: new Date().toISOString() });
  }
  twoStep.disable();
  logger.info('Two-step sign-in turned off');
  res.json({ success: true });
});

router.post('/recovery', loginLimiter, (req, res) => {
  if (!twoStep.isEnabled()) return res.status(409).json({ error: 'Two-step sign-in is off.' });
  if (!needPassword(req, res)) return;
  if (!twoStep.check(req.body && req.body.code).ok) {
    return res.status(403).json({ error: 'That code did not work.', serverTime: new Date().toISOString() });
  }
  const recoveryCodes = twoStep.regenerateRecovery();
  if (!recoveryCodes) return res.status(409).json({ error: 'Two-step sign-in is damaged; reset it first.' });
  logger.info('Two-step recovery codes replaced');
  res.json({ success: true, recoveryCodes });
});

module.exports = router;
