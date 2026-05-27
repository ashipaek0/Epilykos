const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

// Determine log level from environment
const logLevel = process.env.LOG_LEVEL || 'info';

// Define custom format for console (pretty)
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
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
  levels: winston.config.npm.levels,
  transports: [
    // Rotating file transport
    new DailyRotateFile({
      filename: path.join(logDir, 'energy-dashboard-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      format: fileFormat,
      level: logLevel
    }),
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

module.exports = { logger, getLogger };
