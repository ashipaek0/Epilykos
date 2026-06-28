const olog = console.warn;
const fs = require('fs');
console.warn = (...args) => {
  fs.appendFileSync('/tmp/epilykos-pass.log', args.join(' ') + '\n');
  olog.apply(console, args);
};
require('./server.js');
