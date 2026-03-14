'use strict';

// Shared in-memory store — written by bots, read by server.js API
const store = {
  alerts: [],   // last 200 structured alerts (opportunities + matches)
  market: null, // { stats, propCount, requestCount, time } — updated every 30 min by prospectingBot

  addAlert(data) {
    this.alerts.unshift({ ...data, time: new Date().toISOString() });
    if (this.alerts.length > 200) this.alerts.length = 200;
  },

  setMarket(data) {
    this.market = data;
  },
};

module.exports = store;
