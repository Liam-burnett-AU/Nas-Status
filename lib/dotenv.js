'use strict';

const fs = require('node:fs');

/**
 * Minimal .env loader for the Node.js server. Real environment variables
 * always win over the file, so Docker / systemd configuration is never
 * silently overridden.
 */
function loadDotEnv(file, target = process.env) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (!(key in target)) target[key] = value;
  }
  return true;
}

module.exports = { loadDotEnv };
