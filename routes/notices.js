/** Authenticated maintenance state and actions; global API CSRF protection applies. */
'use strict';
const router = require('express').Router();
const check = require('../modules/dbCheck');
const { setConfig } = require('../modules/database');
router.get('/', async (req, res, next) => { try { res.json(await require('../modules/notices').status()); } catch (e) { next(e); } });
router.post('/database/check', (req, res) => { check.run('manual check'); res.status(202).json({ running: true }); });
router.post('/backup/snooze', (req, res) => { setConfig('backup_reminder_until', String(Date.now() + 7 * 86400000)); res.json({ ok: true }); });
module.exports = router;
