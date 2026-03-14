'use strict';

// Shared in-memory store — written by bots, read by server.js API
const store = {
  // ── Alerte prospecting ──────────────────────────────────────────────────
  alerts: [],   // last 200 structured alerts

  addAlert(data) {
    this.alerts.unshift({ ...data, time: new Date().toISOString() });
    if (this.alerts.length > 200) this.alerts.length = 200;
  },

  // ── Date piață (cache din prospectingBot) ───────────────────────────────
  market: null, // { stats, propCount, requestCount, time }

  setMarket(data) {
    this.market = data;
  },

  // ── Activitate per bot ──────────────────────────────────────────────────
  botActivity: {
    marketing: {
      lastRun: null,        // ISO string
      lastStatus: null,     // 'ok' | 'error'
      lastError: null,      // string
      generated: 0,         // postări generate total
      approved: 0,          // aprobate
      rejected: 0,          // respinse
      expired: 0,           // expirate
    },
    prospecting: {
      lastRun: null,
      lastStatus: null,
      lastError: null,
      scans: 0,             // rulări de monitorizare
      opportunitiesFound: 0,
      matchesFound: 0,
    },
  },

  updateBot(botName, patch) {
    if (this.botActivity[botName]) {
      Object.assign(this.botActivity[botName], patch);
    }
  },
};

module.exports = store;
