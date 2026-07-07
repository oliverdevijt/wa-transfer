const fs = require('fs');
const path = require('path');
const os = require('os');

const logFile = path.join(os.tmpdir(), 'wa-transfer', 'wa-transfer.log');
const logLines = [];

function ensureLogDir() {
  const dir = path.dirname(logFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function createLogger(namespace) {
  return {
    info: (msg) => log('INFO', namespace, msg),
    warn: (msg) => log('WARN', namespace, msg),
    error: (msg) => log('ERROR', namespace, msg),
  };
}

function log(level, namespace, msg) {
  const line = `[${new Date().toISOString()}] [${level}] [${namespace}] ${msg}`;
  logLines.push(line);
  if (logLines.length > 2000) logLines.shift();
  try {
    ensureLogDir();
    fs.appendFileSync(logFile, line + '\n', 'utf8');
  } catch (_) {}
  if (level === 'ERROR') console.error(line);
  else console.log(line);
}

function getLogLines(n = 500) {
  return logLines.slice(-n);
}

function getLogFilePath() {
  return logFile;
}

module.exports = { createLogger, getLogLines, getLogFilePath };
