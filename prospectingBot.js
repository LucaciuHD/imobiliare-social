require("dotenv").config();
const fetch = require("node-fetch");
const cron = require("node-cron");
const store = require("./dashboardStore");

const CRM_BASE = "https://simpluimobiliare.crmrebs.com/api";
const CRM_TOKEN = process.env.CRM_TOKEN || "8b5b5946671da2a80fc41481760673ab2868ba99";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

// Toate zonele Craiova din CRM
const ZONES = {
  526:"1 Mai", 527:"Aeroport", 528:"Bariera Vâlcii", 529:"Bordei",
  530:"Brazda lui Novac", 531:"Brestei", 532:"Bucovăț", 533:"Calea București",
  534:"Calea Severinului", 2247:"Central", 535:"Cernele", 536:"Ceț",
  537:"Cornițoiu", 538:"Craiovița Nouă", 2248:"Est", 2249:"Exterior Est",
  2250:"Exterior Nord", 2251:"Exterior Sud", 2252:"Exterior Vest", 539:"Gării",
  540:"George Enescu", 541:"Ghercești", 542:"Lăpuș", 543:"Lăpuș Argeș",
  544:"Lascăr Catargiu", 545:"Lunca", 546:"Matei Basarab", 547:"Mofleni",
  548:"Nisipului", 2253:"Nord", 2254:"Nord-Est", 2255:"Nord-Vest",
  2256:"Periferie", 549:"Plaiul Vulcănești", 550:"Popoveni", 551:"Romanești",
  552:"Rovine", 553:"Sărari", 554:"Siloz", 555:"Sineasca", 2257:"Sud",
  2258:"Sud-Est", 2259:"Sud-Vest", 556:"Titulescu", 2260:"Ultracentral",
  557:"Valea Roșie", 2261:"Vest",
};

const PROP_TYPES = { 1:"Apartament", 2:"Casă", 3:"Teren", 4:"Spațiu comercial", 5:"Birou" };
const UNDER_MARKET_THRESHOLD = 0.88; // sub 88% din medie = oportunitate

// IDs deja alertate — evităm duplicate
const alertedIds = new Set();

// ─── CRM helpers ───────────────────────────────────────────────────────────────

function addToken(url) {
  return url + (url.includes("?") ? "&" : "?") + `token=${CRM_TOKEN}`;
}

async function crmFetch(path) {
  const r = await fetch(addToken(`${CRM_BASE}${path}`));
  if (!r.ok) throw new Error(`CRM ${path}: ${r.status}`);
  return r.json();
}

async function fetchAllPages(path) {
  const results = [];
  let url = addToken(`${CRM_BASE}${path}`);
  while (url) {
    const r = await fetch(url);
    if (!r.ok) break;
    const data = await r.json();
    if (data.results) results.push(...data.results);
    url = data.next ? addToken(data.next) : null;
  }
  return results;
}

// Proprietăți active de vânzare în Craiova (toate sursele)
async function fetchActiveProperties() {
  return fetchAllPages("/properties/?availability=1&for_sale=true&limit=100");
}

// Anunțuri particulari active
async function fetchParticularProperties() {
  return fetchAllPages("/properties/?availability=1&for_sale=true&source=particular&limit=100");
}

// Cereri cumpărători active
async function fetchBuyerRequests() {
  return fetchAllPages("/requests/?availability=2&city=5708&limit=100");
}

// ─── Statistici pe zone ─────────────────────────────────────────────────────

function getPricePerSqm(p) {
  // Folosim price_sqm_sale din CRM dacă există, altfel calculăm
  if (p.price_sqm_sale && p.price_sqm_sale > 100) return Math.round(p.price_sqm_sale);
  const price = p.price_sale;
  const surface = p.surface_useable || p.surface_built;
  if (!price || !surface || surface < 10) return null;
  return Math.round(price / surface);
}

function calculateZoneStats(properties) {
  const byZone = {};
  for (const p of properties) {
    const ppsm = getPricePerSqm(p);
    if (!ppsm || ppsm < 100 || ppsm > 10000) continue; // filtrăm outlieri
    const zoneId = p.zone;
    if (!zoneId) continue;
    if (!byZone[zoneId]) byZone[zoneId] = [];
    byZone[zoneId].push(ppsm);
  }

  const stats = {};
  for (const [zoneId, prices] of Object.entries(byZone)) {
    if (prices.length < 2) continue; // minim 2 proprietăți pentru stats relevante
    const sorted = [...prices].sort((a, b) => a - b);
    const avg = Math.round(prices.reduce((s, v) => s + v, 0) / prices.length);
    stats[zoneId] = {
      avg,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      count: prices.length,
      median: sorted[Math.floor(sorted.length / 2)],
    };
  }
  return stats;
}

// ─── Matching cereri cumpărători ────────────────────────────────────────────

function matchesBuyerRequest(prop, req) {
  // Tip proprietate
  if (req.property_type && req.property_type !== prop.property_type) return false;
  // Tip tranzacție (req.transaction_type 2=cumpărare)
  if (req.transaction_type === 2 && prop.transaction_type !== 1) return false;

  // Preț
  const price = prop.price_sale;
  if (price) {
    if (req.price_filter_gte && price < req.price_filter_gte) return false;
    if (req.price_filter_lte && price > req.price_filter_lte * 1.05) return false; // 5% toleranță
  }

  // Suprafață
  const surface = prop.surface_useable || prop.surface_built;
  if (surface) {
    if (req.surface_useable_filter_gte && surface < req.surface_useable_filter_gte) return false;
    if (req.surface_useable_filter_lte && surface > req.surface_useable_filter_lte * 1.1) return false;
  }

  // Camere
  if (prop.rooms) {
    if (req.rooms_filter_gte && prop.rooms < req.rooms_filter_gte) return false;
    if (req.rooms_filter_lte && prop.rooms > req.rooms_filter_lte) return false;
  }

  // Zonă (dacă cererea are zone specifice)
  if (req.zone && req.zone.length > 0 && prop.zone) {
    if (!req.zone.includes(prop.zone)) return false;
  }

  return true;
}

// ─── Telegram ───────────────────────────────────────────────────────────────

async function sendTelegram(text, chatId = null) {
  if (!BOT_TOKEN) return;
  const target = chatId || ADMIN_CHAT_ID;
  if (!target) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: target,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
}

function formatProperty(p, ppsm) {
  const zone = ZONES[p.zone] || `Zona ${p.zone}`;
  const type = PROP_TYPES[p.property_type] || "Proprietate";
  const surface = p.surface_useable || p.surface_built;
  const crmUrl = `https://simpluimobiliare.crmrebs.com/properties/${p.id}`;
  return [
    `🏠 <b>${p.title || type}</b>`,
    `📍 ${zone}`,
    `💰 ${Number(p.price_sale).toLocaleString("ro-RO")} EUR${ppsm ? ` (${ppsm} EUR/mp)` : ""}`,
    surface ? `📐 ${surface} mp | ${p.rooms || "?"} cam.` : "",
    `🔗 <a href="${crmUrl}">Deschide în CRM</a>`,
  ].filter(Boolean).join("\n");
}

// ─── Raport zilnic statistici pe cartiere ───────────────────────────────────

async function sendZoneStatsReport(stats, properties, chatId = null) {
  const lines = ["📊 <b>STATISTICI PIAȚĂ CRAIOVA</b>\n<i>Prețuri medii EUR/mp (vânzare)</i>\n"];

  const sorted = Object.entries(stats)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20);

  for (const [zoneId, s] of sorted) {
    const zoneName = ZONES[zoneId] || `Zona ${zoneId}`;
    lines.push(
      `<b>${zoneName}</b> (${s.count} prop.)\n` +
      `  Medie: <b>${s.avg} €/mp</b> | Min: ${s.min} | Max: ${s.max}`
    );
  }

  lines.push(`\n📅 ${new Date().toLocaleDateString("ro-RO")} — Total: ${properties.length} proprietăți analizate`);
  await sendTelegram(lines.join("\n"), chatId);
}

// ─── Raport săptămânal trend ─────────────────────────────────────────────────

async function sendWeeklyReport(chatId = null) {
  try {
    console.log("[prospecting] Generez raport săptămânal...");

    const now = new Date();
    const weekAgo = new Date(now - 7 * 24 * 3600 * 1000);
    const twoWeeksAgo = new Date(now - 14 * 24 * 3600 * 1000);

    const allProps = await fetchActiveProperties();

    // Această săptămână vs săptămâna anterioară
    const thisWeek = allProps.filter(p => new Date(p.date_added) >= weekAgo);
    const prevWeek = allProps.filter(p => {
      const d = new Date(p.date_added);
      return d >= twoWeeksAgo && d < weekAgo;
    });

    const statsThis = calculateZoneStats(thisWeek);
    const statsPrev = calculateZoneStats(prevWeek);

    const lines = [
      "📈 <b>RAPORT SĂPTĂMÂNAL PIAȚĂ CRAIOVA</b>",
      `<i>${twoWeeksAgo.toLocaleDateString("ro-RO")} → ${now.toLocaleDateString("ro-RO")}</i>\n`,
    ];

    const allZones = new Set([...Object.keys(statsThis), ...Object.keys(statsPrev)]);
    const trends = [];

    for (const zoneId of allZones) {
      const curr = statsThis[zoneId];
      const prev = statsPrev[zoneId];
      if (!curr) continue;
      const zoneName = ZONES[zoneId] || `Zona ${zoneId}`;
      let trendIcon = "→";
      let trendPct = "";
      if (prev) {
        const diff = ((curr.avg - prev.avg) / prev.avg) * 100;
        trendIcon = diff > 2 ? "📈" : diff < -2 ? "📉" : "→";
        trendPct = ` (${diff > 0 ? "+" : ""}${diff.toFixed(1)}%)`;
      }
      trends.push({ zoneName, curr, prev, trendIcon, trendPct });
    }

    trends.sort((a, b) => b.curr.count - a.curr.count).slice(0, 15).forEach(t => {
      lines.push(
        `${t.trendIcon} <b>${t.zoneName}</b>: ${t.curr.avg} €/mp${t.trendPct}` +
        (t.prev ? ` | prev: ${t.prev.avg} €/mp` : " | date insuficiente prev.")
      );
    });

    lines.push(`\n🏠 Proprietăți noi săpt. aceasta: <b>${thisWeek.length}</b>`);
    lines.push(`🏠 Proprietăți săpt. anterioară: <b>${prevWeek.length}</b>`);

    const allAvgThis = Object.values(statsThis).map(s => s.avg);
    if (allAvgThis.length > 0) {
      const globalAvg = Math.round(allAvgThis.reduce((a, b) => a + b) / allAvgThis.length);
      lines.push(`\n📊 Medie generală Craiova: <b>${globalAvg} €/mp</b>`);
    }

    await sendTelegram(lines.join("\n"), chatId);
    console.log("[prospecting] Raport săptămânal trimis.");
  } catch (e) {
    console.error("[prospecting] Eroare raport săptămânal:", e.message);
    await sendTelegram(`❌ Eroare raport săptămânal: ${e.message}`, chatId);
  }
}

// ─── Task principal la 30 min ────────────────────────────────────────────────

async function runProspecting() {
  try {
    console.log("[prospecting] Rulare monitorizare piață...");

    const [allProperties, buyerRequests] = await Promise.all([
      fetchActiveProperties(),
      fetchBuyerRequests(),
    ]);

    const stats = calculateZoneStats(allProperties);

    // Salvează în dashboard store — acces instant din UI
    const marketStats = {};
    for (const [zoneId, s] of Object.entries(stats)) {
      marketStats[zoneId] = { name: ZONES[zoneId] || `Zona ${zoneId}`, ...s };
    }
    store.setMarket({
      stats: marketStats,
      propCount: allProperties.length,
      requestCount: buyerRequests.length,
      time: new Date().toISOString(),
    });

    const alerts = [];

    for (const prop of allProperties) {
      if (alertedIds.has(prop.id)) continue;

      const ppsm = getPricePerSqm(prop);
      const zoneStats = prop.zone ? stats[prop.zone] : null;

      // Alert: proprietate sub media pieței
      if (ppsm && zoneStats && ppsm < zoneStats.avg * UNDER_MARKET_THRESHOLD) {
        const pctBelow = Math.round((1 - ppsm / zoneStats.avg) * 100);
        const zoneName = ZONES[prop.zone] || `Zona ${prop.zone}`;
        alerts.push(
          `🔥 <b>OPORTUNITATE — ${pctBelow}% sub piață!</b>\n` +
          formatProperty(prop, ppsm) +
          `\n📊 Media în ${zoneName}: ${zoneStats.avg} €/mp`
        );
        store.addAlert({
          type: "opportunity",
          pctBelow,
          propId: prop.id,
          propTitle: prop.title || PROP_TYPES[prop.property_type] || "Proprietate",
          zone: zoneName,
          ppsm,
          avgPpsm: zoneStats.avg,
          price: prop.price_sale,
          surface: prop.surface_useable || prop.surface_built,
          rooms: prop.rooms,
          crmUrl: `https://simpluimobiliare.crmrebs.com/properties/${prop.id}`,
        });
        alertedIds.add(prop.id);
      }

      // Alert: match cu cereri cumpărători
      const matchingRequests = buyerRequests.filter(req => matchesBuyerRequest(prop, req));
      if (matchingRequests.length > 0 && !alertedIds.has(`match_${prop.id}`)) {
        const reqList = matchingRequests.slice(0, 3).map(r =>
          `  👤 <a href="https://simpluimobiliare.crmrebs.com/requests/${r.id}">${r.title || r.display_id}</a>`
        ).join("\n");
        alerts.push(
          `🎯 <b>MATCH CERERE CLIENT!</b>\n` +
          formatProperty(prop, ppsm) +
          `\n\n<b>Potrivit pentru ${matchingRequests.length} cerere(i):</b>\n${reqList}`
        );
        store.addAlert({
          type: "match",
          propId: prop.id,
          propTitle: prop.title || PROP_TYPES[prop.property_type] || "Proprietate",
          zone: ZONES[prop.zone] || `Zona ${prop.zone}`,
          ppsm,
          price: prop.price_sale,
          surface: prop.surface_useable || prop.surface_built,
          rooms: prop.rooms,
          matchCount: matchingRequests.length,
          matches: matchingRequests.slice(0, 3).map(r => ({
            id: r.id,
            title: r.title || r.display_id,
            url: `https://simpluimobiliare.crmrebs.com/requests/${r.id}`,
          })),
          crmUrl: `https://simpluimobiliare.crmrebs.com/properties/${prop.id}`,
        });
        alertedIds.add(`match_${prop.id}`);
      }
    }

    const oppCount = alerts.filter(a => a.includes('OPORTUNITATE')).length;
    const mCount = alerts.filter(a => a.includes('MATCH')).length;
    store.updateBot('prospecting', {
      lastRun: new Date().toISOString(),
      lastStatus: 'ok',
      lastError: null,
      scans: store.botActivity.prospecting.scans + 1,
      opportunitiesFound: store.botActivity.prospecting.opportunitiesFound + oppCount,
      matchesFound: store.botActivity.prospecting.matchesFound + mCount,
    });

    if (alerts.length > 0) {
      console.log(`[prospecting] ${alerts.length} alerte noi`);
      for (const alert of alerts) {
        await sendTelegram(alert);
        await new Promise(r => setTimeout(r, 500)); // pauză între mesaje
      }
    } else {
      console.log("[prospecting] Nicio alertă nouă.");
    }

    // Curăță alertedIds dacă devine prea mare (reține maxim 5000 IDs)
    if (alertedIds.size > 5000) alertedIds.clear();

  } catch (e) {
    console.error("[prospecting] Eroare:", e.message);
    store.updateBot('prospecting', { lastStatus: 'error', lastError: e.message });
    await sendTelegram(`❌ Eroare prospecting: ${e.message}`).catch(() => {});
  }
}

// ─── Comandă manuală: statistici la cerere ──────────────────────────────────

async function sendManualStats(chatId = null) {
  try {
    const properties = await fetchActiveProperties();
    const stats = calculateZoneStats(properties);
    await sendZoneStatsReport(stats, properties, chatId);
  } catch (e) {
    await sendTelegram(`❌ Eroare statistici: ${e.message}`, chatId);
  }
}

// ─── Cron schedules ─────────────────────────────────────────────────────────

// Monitorizare la fiecare 30 de minute
cron.schedule("*/30 * * * *", runProspecting, { timezone: "Europe/Bucharest" });

// Statistici zilnice dimineața la 9:00
cron.schedule("0 9 * * *", sendManualStats, { timezone: "Europe/Bucharest" });

// Raport săptămânal luni la 8:00
cron.schedule("0 8 * * 1", sendWeeklyReport, { timezone: "Europe/Bucharest" });

console.log("🔍 Prospecting Bot pornit — monitorizare la 30 min, stats zilnice 9:00, raport luni 8:00");

module.exports = { runProspecting, sendManualStats, sendWeeklyReport };
