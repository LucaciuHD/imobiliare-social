'use strict';
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'dismissed.json');

// Încarcă IDs persisate de pe disc
let ids = new Set();
try {
  const raw = fs.readFileSync(FILE, 'utf8');
  ids = new Set(JSON.parse(raw));
  console.log(`[dismissed] ${ids.size} proprietăți marcate ca preluat`);
} catch (_) { /* fișier inexistent la prima rulare */ }

function save() {
  fs.writeFileSync(FILE, JSON.stringify([...ids]), 'utf8');
}

module.exports = {
  has:     (id) => ids.has(String(id)),
  add:     (id) => { ids.add(String(id)); save(); },
  remove:  (id) => { ids.delete(String(id)); save(); },
  all:     ()   => [...ids],
};
