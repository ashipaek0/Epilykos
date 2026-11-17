'use strict';
/**
 * Flush a file (or a folder) to disk without tripping over Windows.
 *
 * On Linux and macOS this is plain fsync, exactly as before. On Windows a folder cannot be opened or
 * flushed (the call fails with EPERM or EISDIR) and a file must be open for writing to be flushed, so
 * there a folder is skipped (NTFS journals its own metadata) and a file is opened read/write.
 */
const fs = require('node:fs');

const WIN = () => process.platform === 'win32';

/** fsync the file or folder at `file`. */
function syncPath(file) {
  let fd;
  if (WIN()) {
    if (fs.statSync(file).isDirectory()) return;
    fd = fs.openSync(file, 'r+');
  } else {
    fd = fs.openSync(file, 'r');
  }
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** fsync an open descriptor; on Windows an unsupported flush is skipped rather than thrown. */
function syncFd(fd) {
  try { fs.fsyncSync(fd); }
  catch (error) {
    if (WIN() && ['EPERM', 'EISDIR', 'EINVAL'].includes(error.code)) return;
    throw error;
  }
}

module.exports = { syncPath, syncFd };
