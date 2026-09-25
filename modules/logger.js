const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// File logging is on by default (Docker Compose deployments read logs/).
// LOG_TO_FILE=false logs to stdout/stderr only and never touches the
// filesystem — required for a read-only container root (EpilykosOS, where
// journald collects stdout). LOG_DIR overrides the log directory.
const logToFile = !/^(false|0|no|off)$/i.test(String(process.env.LOG_TO_FILE ?? 'true'));
const logDir = process.env.LOG_DIR ? path.resolve(process.env.LOG_DIR) : path.join(__dirname, '../logs');
if (logToFile && !fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

// Determine log level from environment
const logLevel = process.env.LOG_LEVEL || 'info';

// winston only merges object/Error extra args into the log entry; primitive
// extras such as logger.warn('Save failed:', err.message) are dropped. Append
// them to the message so the reason is never lost.
const SPLAT = Symbol.for('splat');
const appendPrimitiveArgs = winston.format((info) => {
  const extras = info[SPLAT];
  if (Array.isArray(extras)) {
    const primitives = extras.filter(a => a === null || (typeof a !== 'object' && typeof a !== 'function'));
    if (primitives.length) info.message = `${info.message} ${primitives.map(String).join(' ')}`;
  }
  return info;
});

// Define custom format for console (pretty)
// Colour codes only when a human is watching a terminal; journald and
// `docker logs` capture plain text.
const consoleFormat = winston.format.combine(
  ...(process.stdout.isTTY ? [winston.format.colorize()] : []),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level}]: ${message}${metaStr}`;
  })
);

// File format (JSON for structured logging)
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);

// Create logger
const logger = winston.createLogger({
  level: logLevel,
  format: appendPrimitiveArgs(),
  levels: winston.config.npm.levels,
  transports: [
    // Rotating file transport (disabled with LOG_TO_FILE=false)
    ...(logToFile ? [new DailyRotateFile({
      filename: path.join(logDir, 'energy-dashboard-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      format: fileFormat,
      level: logLevel
    })] : []),
    // Console transport (always, but with level)
    new winston.transports.Console({
      format: consoleFormat,
      level: logLevel
    })
  ]
});

// Helper to log HTTP requests (morgan stream)
logger.stream = {
  write: (message) => {
    logger.http(message.trim());
  }
};

// Export a child logger factory for modules
function getLogger(moduleName) {
  return logger.child({ module: moduleName });
}

module.exports = { logger, getLogger, logToFile, logDir };
