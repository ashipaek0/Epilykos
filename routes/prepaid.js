/**
 * Prepaid meter API (modules/prepaidMeter.js). Anyone who can see the dashboard may read the balance, unless it is set to be
 * private, in which case only a signed-in user gets it; the entries, the settings and every change need a signed-in user.
 * Global API CSRF protection applies to the changes.
 */
'use strict';
const router = require('express').Router();
const { isAuthenticated } = require('../modules/sessionAuth');
const prepaid = require('../modules/prepaidMeter');

const authed = req => !!(req.session && req.session.authenticated);
const answer = (res, r) => (r.error ? res.status(400).json({ error: r.error }) : res.json(r));

router.get('/', (req, res, next) => { try { res.set('Cache-Control', 'no-store'); res.json(prepaid.view({ authed: authed(req) })); } catch (e) { next(e); } });
router.get('/settings', isAuthenticated, (req, res, next) => { try { res.json(prepaid.settingsView()); } catch (e) { next(e); } });
router.post('/settings', isAuthenticated, (req, res, next) => { try { res.json(prepaid.saveSettings(req.body || {})); } catch (e) { next(e); } });
router.post('/recharge', isAuthenticated, (req, res, next) => { try { const b = req.body || {}; answer(res, prepaid.addRecharge(b.units, b.amount, b.ts)); } catch (e) { next(e); } });
router.post('/correct', isAuthenticated, (req, res, next) => { try { const b = req.body || {}; answer(res, prepaid.addCorrection(b.units, b.learn === true)); } catch (e) { next(e); } });
router.post('/undo', isAuthenticated, (req, res, next) => { try { answer(res, prepaid.undoLast()); } catch (e) { next(e); } });

module.exports = router;
