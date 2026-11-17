'use strict';
/** The serial port a new device starts with when none is chosen: COM3 on Windows, the first USB adapter elsewhere. */
function defaultSerialPath(platform = process.platform) {
  return platform === 'win32' ? 'COM3' : '/dev/ttyUSB0';
}
module.exports = { defaultSerialPath };
