/**
 * Dashboard presets (/api/presets), for the layout editor's gallery. Signed in only, like the editor itself.
 * Read-only: the presets are files that ship with the app.
 *
 * @module routes/presets
 */
const express = require('express');
const { listPresets, getPreset, previewPath } = require('../modules/presets');

const router = express.Router();

router.get('/', (req, res) => {
  try { res.json(listPresets()); } catch (e) { res.status(500).json({ error: 'The presets could not be read' }); }
});

router.get('/:id/preview', (req, res) => {
  const file = previewPath(req.params.id);
  if (!file) return res.status(404).json({ error: 'No picture for that preset' });
  res.set('Cache-Control', 'private, max-age=3600');
  res.type('image/webp').sendFile(file);
});

router.get('/:id', (req, res) => {
  let preset = null;
  try { preset = getPreset(req.params.id); } catch (e) { return res.status(500).json({ error: 'That preset could not be read' }); }
  if (!preset) return res.status(404).json({ error: 'Preset not found' });
  res.json(preset);
});

module.exports = router;
