'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Path of a bundled profile file by id, or null. The path is built from the
 * matching directory entry, never from the request, so no id can escape the
 * profiles directory.
 */
function bundledProfilePath(subdir, id) {
  const dir = path.join(__dirname, '..', 'profiles', subdir);
  const wanted = `${String(id || '')}.json`;
  let entry;
  try { entry = fs.readdirSync(dir).find(f => f === wanted); } catch (_) { return null; }
  return entry ? path.join(dir, entry) : null;
}

module.exports = { bundledProfilePath };
