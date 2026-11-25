'use strict';
/**
 * Uploads (a restore file, a dashboard layout): multer writing into a folder only this process can read, not loose in
 * the shared temp directory (os.tmpdir() honours TMPDIR; EpilykosOS points it at a tmpfs), only .db or .json files,
 * at most 50 MB.
 *
 * @module uploads
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');

const MAX_BYTES = 50 * 1024 * 1024;

function createUploads() {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilykos-uploads-'));
  const upload = multer({
    dest: uploadDir,
    fileFilter: (req, file, cb) => {
      if (file.originalname.endsWith('.db') || file.originalname.endsWith('.json')) cb(null, true);
      else cb(new Error('Only .db or .json files allowed'));
    },
    limits: { fileSize: MAX_BYTES }
  });
  /** Path of a multer upload, checked to sit in the upload directory; else null. */
  function uploadedFilePath(file) {
    const root = path.resolve(uploadDir);
    const resolved = path.resolve(String((file && file.path) || ''));
    return resolved.startsWith(root + path.sep) ? resolved : null;
  }
  /** Remove the folder (at shutdown); a later start makes a new one. */
  function remove() { try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch (_) { /* nothing to do */ } }
  return { uploadDir, upload, uploadedFilePath, remove };
}

module.exports = { createUploads, MAX_BYTES };
