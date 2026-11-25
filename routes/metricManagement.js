/**
 * Metric management routes (mounted at /api): the metric list, creating one, and deleting one or several (Settings >
 * Metrics). Signed-in only.
 *
 * @module routes/metricManagement
 */
const express = require('express');
const { logger } = require('../modules/logger');
const { isAuthenticated } = require('../modules/sessionAuth');

const router = express.Router();

router.get('/metrics/list', isAuthenticated, (req, res) => {
  try {
    const { getAllMetrics } = require('../modules/metricsManager');
    const metrics = getAllMetrics();
    res.json(metrics);
  } catch (err) {
    logger.error('Error fetching metrics list:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/metrics/create', isAuthenticated, (req, res) => {
  try {
    const { createMetric } = require('../modules/metricsManager');
    const { name, unit } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    createMetric(name, unit || '');
    res.json({ success: true });
  } catch (err) {
    logger.error('Error creating metric:', err);
    res.status(400).json({ error: 'Failed to create metric' });
  }
});

router.delete('/metrics/:name', isAuthenticated, (req, res) => {
  try {
    const { deleteMetrics } = require('../modules/metricDeletion');
    const { name } = req.params;
    const result = deleteMetrics([name], { deferHistory: true });
    if (result.blocked.length) return res.status(409).json({ error: result.blocked[0].reason });
    res.json({ success: true, roles_cleared: result.rolesCleared, used_by: result.usedBy[name] || [] });
  } catch (err) {
    logger.error('Error deleting metric:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Several at once (Settings > Metrics: select, then Delete selected).
router.post('/metrics/delete', isAuthenticated, (req, res) => {
  const names = req.body && req.body.names;
  if (!Array.isArray(names) || !names.length || names.some(n => typeof n !== 'string')) {
    return res.status(400).json({ error: 'A list of metric names is required' });
  }
  try {
    const result = require('../modules/metricDeletion').deleteMetrics(names, { deferHistory: true });
    res.json({ success: true, deleted: result.deleted, blocked: result.blocked, roles_cleared: result.rolesCleared, used_by: result.usedBy });
  } catch (err) {
    if (err instanceof RangeError) return res.status(400).json({ error: err.message });
    logger.error('Error deleting metrics:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
