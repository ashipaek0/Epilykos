'use strict';
const checks = require('./_checks');
const assert = require('node:assert/strict');
const { pythonCommand } = require('../modules/pythonCommand');
assert.equal(pythonCommand('linux', {}), 'python3');
assert.equal(pythonCommand('win32', {}), 'python');
assert.equal(pythonCommand('win32', { EPILYKOS_PYTHON: 'C:\\Epilykos\\python\\python.exe' }), 'C:\\Epilykos\\python\\python.exe');
assert.equal(pythonCommand('linux', { EPILYKOS_PYTHON: '/opt/py' }), '/opt/py');
checks.done();
