'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * JSON-file persistence for the Node.js server. Writes are atomic
 * (temp file + rename) so a crash never leaves a half-written history.
 */
class FilePersistence {
  constructor(file, { log = () => {} } = {}) {
    this.file = file;
    this.log = log;
  }

  /** @returns {object|null} saved state, or null when there is none */
  read() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.log('warn', `Could not read history file: ${err.message}`);
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      this.quarantine(err);
      return null;
    }
  }

  /** Move an unreadable file aside so it can be inspected, then start fresh. */
  quarantine(err) {
    const backup = `${this.file}.corrupt-${Date.now()}`;
    try { fs.renameSync(this.file, backup); } catch { /* ignore */ }
    this.log('warn', `History file was unreadable (${err.message}); moved it to ${backup} and started fresh.`);
  }

  /** Load into a HistoryStore (and optional Monitor). Returns true when history was restored. */
  load(store, monitor) {
    const data = this.read();
    if (!data) return false;
    try {
      store.importState(data);
      if (monitor && data.monitor) monitor.importState(data.monitor);
      return true;
    } catch (err) {
      this.quarantine(err);
      store.reset();
      return false;
    }
  }

  save(store, monitor) {
    if (!store.dirty) return;
    const state = store.exportState();
    if (monitor) state.monitor = monitor.exportState();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, this.file);
    store.dirty = false;
  }
}

module.exports = { FilePersistence };
