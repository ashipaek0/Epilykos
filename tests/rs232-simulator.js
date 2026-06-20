/**
 * Simulator for RS232 protocols — creates a pseudo-terminal for testing.
 * Requires socat: sudo apt install socat
 * 
 * Usage:
 *   node tests/rs232-simulator.js voltronic    # Simulate a Voltronic inverter
 *   node tests/rs232-simulator.js vedirect     # Simulate Victron VE.Direct
 * 
 * Then configure Epilykos RS232 device with serial_path: /tmp/epilykos-rs232-sim
 */

const { spawn } = require('child_process');
const net = require('net');

const protocol = process.argv[2] || 'voltronic';
const ptyPath = '/tmp/epilykos-rs232-sim';

console.log(`RS232 Simulator: ${protocol}`);
console.log(`PTY: ${ptyPath}`);

// ── Protocol Handlers ───────────────────────────────────────────────────

function voltronicHandler(input) {
  const cmd = input.toString('utf8').trim();
  switch (cmd) {
    case 'QPIGS':
      return '(230.1 50.00 230.1 50.00 1200 950 25.6 0010 85 0035 0000 200.0 25.6 0000\r\n';
    case 'QMOD':
      return '(P\r\n';
    case 'QID':
      return '(EPILYKOS-SIM\r\n';
    case 'QPIWS':
      return '(00000000\r\n';
    default:
      return '(NAK\r\n';
  }
}

function vedirectHandler(input) {
  // Simulate a VE.Direct frame every 2 seconds
  const now = Date.now();
  const frame = [
    `PID\t0x203`,
    `V\t${26200 + Math.round(Math.sin(now / 1000) * 200)}`,
    `I\t${1500 + Math.round(Math.sin(now / 500) * 100)}`,
    `VPV\t${38500 + Math.round(Math.sin(now / 800) * 500)}`,
    `PPV\t${185 + Math.round(Math.sin(now / 300) * 30)}`,
    `SOC\t${872 + Math.round(Math.sin(now / 2000) * 20)}`,
    `T\t${27 + Math.round(Math.sin(now / 1000))}`,
    `H1\t221`,
    `H5\t12345`,
    `HSDS\t42`,
    `MPPT\t2`,
    `LOAD\tON`,
    `CS\t3`,
    `Checksum\t0`,
  ];
  return frame.join('\n') + '\n';
}

// ── PTY via socat ───────────────────────────────────────────────────────

const isStreaming = protocol === 'vedirect';
const handler = isStreaming ? vedirectHandler : voltronicHandler;

const socat = spawn('socat', [
  `pty,link=${ptyPath},raw,echo=0`,
  `exec:node -e "
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin });
    const handler = ${handler.toString()};
    ${isStreaming ? `
      setInterval(() => {
        const response = handler('');
        process.stdout.write(response);
      }, 2000);
    ` : `
      rl.on('line', (line) => {
        const response = handler(line);
        process.stdout.write(response);
        process.stdout.flush?.();
      });
    `}
  "`,
]);

socat.on('error', err => {
  console.error('socat error:', err.message);
  console.log('Ensure socat is installed: sudo apt install socat');
});

console.log(`Simulator running on ${ptyPath} (${isStreaming ? 'streaming' : 'poll/response'})`);
console.log('Press Ctrl+C to stop');

process.on('SIGINT', () => {
  socat.kill();
  process.exit(0);
});
