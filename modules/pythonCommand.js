'use strict';
/** The Python used for the Bluetooth helper and Tuya: EPILYKOS_PYTHON if set (the Windows installer points it at its own copy), else python3, or python on Windows. */
function pythonCommand(platform = process.platform, env = process.env) {
  return env.EPILYKOS_PYTHON || (platform === 'win32' ? 'python' : 'python3');
}
module.exports = { pythonCommand };
