'use strict';

// Shared in-memory store — written by prospectingBot, read by server.js API
const store = {
  alerts: [], // last 200 structured alerts

  addAlert(data) {
    this.alerts.unshift({ ...data, time: new Date().toISOString() });
    if (this.alerts.length > 200) this.alerts.length = 200;
  },
};

module.exports = store;
