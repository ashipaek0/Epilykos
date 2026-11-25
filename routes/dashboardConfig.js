/**
 * Dashboard layout routes (mounted at /api): save the layout, export it as a file, and import one (merged with the
 * dashboards already there, or replacing them). Signed-in only. Reading the layout is in routes/metrics.js (a visitor
 * gets the dashboards chosen for them). An import comes from an upload folder: the upload helpers are passed in.
 *
 * @module routes/dashboardConfig
 */
const express = require('express');
const fs = require('fs');
const { logger } = require('../modules/logger');
const { isAuthenticated } = require('../modules/sessionAuth');
const { getDashboardConfig, saveDashboardConfig } = require('../modules/dashboard-config');

/** @param {{upload: object, uploadedFilePath: Function}} deps multer's upload and the check that a file sits in the upload folder */
module.exports = function createDashboardConfigRoutes({ upload, uploadedFilePath }) {
  const router = express.Router();

  router.post('/dashboard-config', isAuthenticated, (req, res) => {
    try {
      saveDashboardConfig(req.body);
      res.json({ success: true });
    } catch (err) {
      logger.error('Error saving dashboard config:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/dashboard-config/export', isAuthenticated, (req, res) => {
    const config = getDashboardConfig();
    res.setHeader('Content-Disposition', 'attachment; filename="dashboard-layout.json"');
    res.setHeader('Content-Type', 'application/json');
    res.json(config);
  });

  router.post('/dashboard-config/import', isAuthenticated, upload.single('layout'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const uploaded = uploadedFilePath(req.file);
    if (!uploaded) return res.status(400).json({ error: 'Invalid upload' });
    try {
      const content = fs.readFileSync(uploaded, 'utf8');
      const imported = JSON.parse(content);
      if (!imported.dashboards || !Array.isArray(imported.dashboards)) {
        throw new Error('Invalid dashboard config format');
      }
      // Merge: add imported dashboards to existing ones, avoiding ID collisions
      if (req.query.merge !== 'false') {
        const existing = getDashboardConfig();
        const existingIds = new Set(existing.dashboards.map(d => d.id));
        for (const db of imported.dashboards) {
          if (existingIds.has(db.id)) {
            db.id = 'db_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
            if (db.name) db.name += ' (imported)';
          }
          existing.dashboards.push(db);
          existingIds.add(db.id);
        }
        saveDashboardConfig(existing);
      } else {
        saveDashboardConfig(imported);
      }
      fs.unlinkSync(uploaded);
      res.json({ success: true });
    } catch (err) {
      if (fs.existsSync(uploaded)) fs.unlinkSync(uploaded);
      logger.error('Error importing dashboard config:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
