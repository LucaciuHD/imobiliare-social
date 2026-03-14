require("dotenv").config();
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const cron = require("node-cron");
const store     = require("./dashboardStore");
const dismissed = require("./dismissedStore");

const CRM_BASE = "https://simpluimobiliare.crmrebs.com/api";
const CRM_WEB  = "https://simpluimobiliare.crmrebs.com";
const CRM_TOKEN    = process.env.CRM_TOKEN    || "8b5b5946671da2a80fc41481760673ab2868ba99";
const CRM_USERNAME = process.env.CRM_USERNAME || "lucadanila@simpluimobiliare.com";
const CRM_PASSWORD = process.env.CRM_PASSWORD || "Nuamparola123!";
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

const UNDER_MARKET_THRESHOLD = 0.85; // 15% sub medie = oportunitate
const alertedIds = new Set();

// ─── Sesiune CRM web (market-snapshot) ──────────────────────────────────────

let session = { csrftoken: null, sessionid: null };

async function crmLogin() {
  try {
    const loginPageRes = await fetch(`${CRM_WEB}/accounts/login/`, {
      headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" },
    });
    const html = await loginPageRes.text();
    const csrfToken  = html.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/)?.[1] || "";
    const csrfCookie = (loginPageRes.headers.get("set-cookie") || "").match(/csrftoken=([^;]+)/)?.[1] || "";

    const loginRes = await fetch(`${CRM_WEB}/accounts/login/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": `csrftoken=${csrfCookie}`,
        "User-Agent": "Mozilla/5.0",
        "Referer": `${CRM_WEB}/accounts/login/`,
      },
      body: new URLSearchParams({
        csrfmiddlewaretoken: csrfToken,
        username: CRM_USERNAME,
        password: CRM_PASSWORD,
        next: "/",
      }).toString(),
      redirect: "manual",
    });

    const rawCookies = loginRes.headers.raw?.()?.["set-cookie"] || [];
    const cookieArr  = Array.isArray(rawCookies) ? rawCookies : [rawCookies];
    const sessionid  = cookieArr.find(c => c.includes("sessionid="))?.match(/sessionid=([^;]+)/)?.[1];
    const newCsrf    = cookieArr.find(c => c.includes("csrftoken="))?.match(/csrftoken=([^;]+)/)?.[1] || csrfCookie;

    if (sessionid) {
      session = { csrftoken: newCsrf, sessionid };
      console.log("[prospecting] Login CRM reușit");
      return true;
    }
    console.error("[prospecting] Login CRM eșuat — sessionid lipsă");
    return false;
  } catch (e) {
    console.error("[prospecting] Login eroare:", e.message);
    return false;
  }
}

// ─── Market-snapshot fetch + parse ──────────────────────────────────────────

async function fetchSnapshotPage(page) {
  if (!session.sessionid) {
    if (!(await crmLogin())) return null;
  }
  const body = new URLSearchParams({ all_region_obj: "18", page: String(page) });
  let r = await fetch(`${CRM_WEB}/market-snapshot/search/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      "Cookie": `csrftoken=${session.csrftoken}; sessionid=${session.sessionid}`,
      "X-CSRFToken": session.csrftoken,
      "User-Agent": "Mozilla/5.0",
      "Referer": `${CRM_WEB}/market-snapshot/listings/`,
    },
    body: body.toString(),
  });
  // sesiune expirată → re-login o singură dată
  if (r.status === 403 || r.status === 302) {
    session = { csrftoken: null, sessionid: null };
    if (!(await crmLogin())) return null;
    r = await fetch(`${CRM_WEB}/market-snapshot/search/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        "Cookie": `csrftoken=${session.csrftoken}; sessionid=${session.sessionid}`,
        "X-CSRFToken": session.csrftoken,
        "User-Agent": "Mozilla/5.0",
        "Referer": `${CRM_WEB}/market-snapshot/listings/`,
      },
      body: body.toString(),
    });
  }
  if (!r.ok) { console.error("[prospecting] Snapshot page error:", r.status); return null; }
  const data = await r.json();
  return data.success ? data.response : null;
}

function parseSnapshotHtml(html) {
  const $ = cheerio.load(html);
  const listings = [];

  $("tr[data-id]").each((_i, row) => {
    const id = $(row).attr("data-id")?.trim();
    if (!id) return;

    const typeText     = $(row).find(".ad-property-type-display").text().trim();
    const featuresText = $(row).find(".anunturi-features").text().replace(/\s+/g, " ").trim();
    const tds          = $(row).find("td");
    const locationText = $(tds[4]).text().trim();
    const priceText    = $(tds[5]).text().trim();
    const sourceUrl    = $(row).find(".publisher-sources-icons a").first().attr("href") || "";

    // Tip tranzacție
    const isRent = /închiriat|inchiriat/i.test(typeText);
    const isSale = /vânzare|vanzare/i.test(typeText);
    if (!isRent && !isSale) return;
    const transType = isRent ? "rent" : "sale";

    // Tip proprietate
    let propType = null;
    if (/apartament/i.test(typeText))              propType = "apartment";
    else if (/casă|casa|vilă|vila/i.test(typeText)) propType = "house";
    else if (/teren/i.test(typeText))               propType = "land";
    else if (/spațiu|spatiu|comercial|birou|industrial/i.test(typeText)) propType = "commercial";
    if (!propType) return;

    // Suprafață
    let surface = null;
    const surfMatch = featuresText.match(/S\.[UT]\.\s*([\d,.]+)\s*mp/i);
    if (surfMatch) surface = parseFloat(surfMatch[1].replace(/\./g, "").replace(",", "."));

    // Preț
    let price = null;
    const priceMatch = priceText.replace(/\./g, "").match(/([\d,]+)\s*€/);
    if (priceMatch) price = parseInt(priceMatch[1].replace(",", ""), 10);
    if (!price || price < 100) return;

    // Zonă — only Craiova listings
    let zone = null;
    if (locationText.includes("Craiova")) {
      const parts = locationText.split(",").map(s => s.trim());
      zone = (parts[0] && parts[0] !== "Craiova") ? parts[0] : "Craiova";
    } else {
      return; // în afara Craiovei, ignorăm
    }

    // Preț/mp (doar vânzare cu suprafață)
    let ppsm = null;
    if (isSale && surface && surface >= 10) {
      ppsm = Math.round(price / surface);
      if (ppsm < 100 || ppsm > 20000) ppsm = null;
    }

    listings.push({ id, typeText, propType, transType, surface, price, ppsm, zone, locationText, sourceUrl });
  });

  return listings;
}

async function fetchAllMarketSnapshot() {
  const allListings = [];
  const MAX_PAGES = 60;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetchSnapshotPage(page);
    if (!res?.html) break;
    const parsed = parseSnapshotHtml(res.html);
    if (!parsed.length) break;
    allListings.push(...parsed);
    console.log(`[prospecting] Pagina ${page}: ${parsed.length} anunțuri (total ${allListings.length})`);
    if (parsed.length < 18) break; // ultima pagină
    await new Promise(r => setTimeout(r, 350));
  }
  console.log(`[prospecting] Total anunțuri particulare Craiova: ${allListings.length}`);
  return allListings;
}

// ─── Statistici pe segmente ──────────────────────────────────────────────────

const PROP_LABEL = { apartment: "Apartamente", house: "Case/Vile", land: "Terenuri", commercial: "Spații comerciale" };
const TRANS_LABEL = { sale: "Vânzare", rent: "Închiriere" };

function calculateSegmentStats(listings) {
  // Grupare: propType_transType → zone → [prețuri]
  const bySegZone = {};

  for (const l of listings) {
    const metric = l.transType === "sale" ? l.ppsm : l.price; // €/mp pt vânzare, €/lună pt chirie
    if (!metric) continue;
    const segKey = `${l.propType}_${l.transType}`;
    if (!bySegZone[segKey]) bySegZone[segKey] = {};
    if (!bySegZone[segKey][l.zone]) bySegZone[segKey][l.zone] = [];
    bySegZone[segKey][l.zone].push(metric);
  }

  const segments = {};
  for (const [segKey, zones] of Object.entries(bySegZone)) {
    segments[segKey] = {};
    for (const [zone, prices] of Object.entries(zones)) {
      if (prices.length < 2) continue;
      const sorted = [...prices].sort((a, b) => a - b);
      const avg = Math.round(prices.reduce((s, v) => s + v, 0) / prices.length);
      segments[segKey][zone] = { avg, min: sorted[0], max: sorted[sorted.length - 1], count: prices.length };
    }
  }
  return segments;
}

// Stats backward-compatible (apartamente de vânzare) pentru dashboard
function buildLegacyStats(segments) {
  const aptSale = segments["apartment_sale"] || {};
  const stats = {};
  for (const [zone, s] of Object.entries(aptSale)) {
    if (s.count < 2) continue;
    stats[zone] = { name: zone, ...s };
  }
  return stats;
}

// ─── Detecție oportunități ───────────────────────────────────────────────────

function findOpportunities(listings, segments) {
  const opps = [];
  for (const l of listings) {
    if (l.transType !== "sale" || !l.ppsm) continue;
    const seg = segments[`${l.propType}_sale`]?.[l.zone];
    if (!seg || seg.count < 3) continue;
    if (l.ppsm < seg.avg * UNDER_MARKET_THRESHOLD) {
      const pctBelow = Math.round((1 - l.ppsm / seg.avg) * 100);
      opps.push({ ...l, pctBelow, avgPpsm: seg.avg });
    }
  }
  return opps;
}

// ─── CRM API: cereri cumpărători ─────────────────────────────────────────────

function addToken(url) {
  return url + (url.includes("?") ? "&" : "?") + `token=${CRM_TOKEN}`;
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

async function fetchBuyerRequests() {
  return fetchAllPages("/requests/?availability=2&city=5708&limit=100");
}

function matchesBuyerRequest(listing, req) {
  const propTypeMap = { apartment: 1, house: 2, land: 3, commercial: 4 };
  if (req.property_type && propTypeMap[listing.propType] !== req.property_type) return false;
  if (req.transaction_type === 2 && listing.transType !== "sale") return false;
  if (listing.price) {
    if (req.price_filter_gte && listing.price < req.price_filter_gte) return false;
    if (req.price_filter_lte && listing.price > req.price_filter_lte * 1.05) return false;
  }
  if (listing.surface) {
    if (req.surface_useable_filter_gte && listing.surface < req.surface_useable_filter_gte) return false;
    if (req.surface_useable_filter_lte && listing.surface > req.surface_useable_filter_lte * 1.1) return false;
  }
  return true;
}

// ─── Telegram ────────────────────────────────────────────────────────────────

async function sendTelegram(text, chatId = null) {
  if (!BOT_TOKEN) return;
  const target = chatId || ADMIN_CHAT_ID;
  if (!target) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: target, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
}

// ─── Task principal ───────────────────────────────────────────────────────────

async function runProspecting() {
  try {
    console.log("[prospecting] Rulare monitorizare piață...");

    // 1. Fetch anunțuri particulare + cereri cumpărători în paralel
    const [listings, buyerRequests] = await Promise.all([
      fetchAllMarketSnapshot(),
      fetchBuyerRequests(),
    ]);

    // 2. Statistici pe segmente
    const segments = calculateSegmentStats(listings);
    const legacyStats = buildLegacyStats(segments);

    // 3. Salvează în store
    store.setMarket({
      stats: legacyStats,         // backward compat pentru dashboard (apartamente vânzare)
      segments,                   // date complete pe toate segmentele
      propCount: listings.length,
      requestCount: buyerRequests.length,
      time: new Date().toISOString(),
    });

    // 4. Detecție oportunități
    const opps = findOpportunities(listings, segments);
    let newOpps = 0, newMatches = 0;
    const alerts = [];

    for (const opp of opps) {
      if (alertedIds.has(opp.id) || dismissed.has(opp.id)) continue;
      alertedIds.add(opp.id);
      newOpps++;
      const ptLabel = PROP_LABEL[opp.propType] || opp.propType;
      alerts.push(
        `🔥 <b>OPORTUNITATE — ${opp.pctBelow}% sub piață!</b>\n` +
        `📍 ${opp.zone} | ${ptLabel}\n` +
        `💰 ${opp.price.toLocaleString("ro-RO")} €${opp.surface ? ` (${opp.ppsm} €/mp)` : ""}\n` +
        `📊 Media zonă: ${opp.avgPpsm} €/mp\n` +
        `🔗 <a href="${opp.sourceUrl || `${CRM_WEB}/market-snapshot/view/${opp.id}/`}">Deschide anunț</a>`
      );
      store.addAlert({
        type: "opportunity",
        pctBelow: opp.pctBelow,
        propId: opp.id,
        propTitle: opp.typeText,
        zone: opp.zone,
        ppsm: opp.ppsm,
        avgPpsm: opp.avgPpsm,
        price: opp.price,
        surface: opp.surface,
        crmUrl: `${CRM_WEB}/market-snapshot/view/${opp.id}/`,
      });
    }

    // 5. Match-uri cereri cumpărători
    for (const l of listings) {
      if (alertedIds.has(`match_${l.id}`) || dismissed.has(l.id)) continue;
      const matching = buyerRequests.filter(req => matchesBuyerRequest(l, req));
      if (!matching.length) continue;
      alertedIds.add(`match_${l.id}`);
      newMatches++;
      const reqList = matching.slice(0, 3).map(r =>
        `  👤 <a href="${CRM_WEB}/requests/${r.id}">${r.title || r.display_id || r.id}</a>`
      ).join("\n");
      alerts.push(
        `🎯 <b>MATCH CERERE CLIENT!</b>\n` +
        `📍 ${l.zone} | ${PROP_LABEL[l.propType] || l.propType}\n` +
        `💰 ${l.price.toLocaleString("ro-RO")} €\n` +
        `<b>${matching.length} cerere(i) potrivite:</b>\n${reqList}\n` +
        `🔗 <a href="${CRM_WEB}/market-snapshot/view/${l.id}/">Anunț particular</a>`
      );
      store.addAlert({
        type: "match",
        propId: l.id,
        propTitle: l.typeText,
        zone: l.zone,
        price: l.price,
        surface: l.surface,
        matchCount: matching.length,
        matches: matching.slice(0, 3).map(r => ({
          id: r.id,
          title: r.title || r.display_id || String(r.id),
          url: `${CRM_WEB}/requests/${r.id}`,
        })),
        crmUrl: `${CRM_WEB}/market-snapshot/view/${l.id}/`,
      });
    }

    // 6. Actualizează store bot activity
    store.updateBot("prospecting", {
      lastRun: new Date().toISOString(),
      lastStatus: "ok",
      lastError: null,
      scans: store.botActivity.prospecting.scans + 1,
      opportunitiesFound: store.botActivity.prospecting.opportunitiesFound + newOpps,
      matchesFound: store.botActivity.prospecting.matchesFound + newMatches,
    });

    if (alerts.length > 0) {
      console.log(`[prospecting] ${alerts.length} alerte noi (${newOpps} opp, ${newMatches} match)`);
      for (const a of alerts) {
        await sendTelegram(a);
        await new Promise(r => setTimeout(r, 500));
      }
    } else {
      console.log("[prospecting] Nicio alertă nouă.");
    }

    if (alertedIds.size > 10000) alertedIds.clear();

  } catch (e) {
    console.error("[prospecting] Eroare:", e.message);
    store.updateBot("prospecting", { lastStatus: "error", lastError: e.message });
    await sendTelegram(`❌ Eroare prospecting: ${e.message}`).catch(() => {});
  }
}

// ─── Raport săptămânal ───────────────────────────────────────────────────────

async function sendWeeklyReport(chatId = null) {
  try {
    if (!store.market?.segments) {
      await sendTelegram("⏳ Datele de piață nu sunt încă disponibile. Rulează mai întâi o scanare.", chatId);
      return;
    }
    const aptSale = store.market.segments["apartment_sale"] || {};
    const lines = ["📈 <b>RAPORT SĂPTĂMÂNAL PIAȚĂ CRAIOVA</b>\n<i>Apartamente de vânzare — €/mp</i>\n"];
    Object.entries(aptSale)
      .filter(([, s]) => s.count >= 3)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 20)
      .forEach(([zone, s]) => {
        lines.push(`<b>${zone}</b> (${s.count}): <b>${s.avg} €/mp</b> | ${s.min}–${s.max}`);
      });
    lines.push(`\n🏠 Total anunțuri analizate: ${store.market.propCount}`);
    await sendTelegram(lines.join("\n"), chatId);
  } catch (e) {
    await sendTelegram(`❌ Eroare raport: ${e.message}`, chatId);
  }
}

async function sendManualStats(chatId = null) {
  await sendWeeklyReport(chatId);
}

// ─── Cron ────────────────────────────────────────────────────────────────────

cron.schedule("*/30 * * * *", runProspecting, { timezone: "Europe/Bucharest" });
cron.schedule("0 9 * * *",   sendManualStats,  { timezone: "Europe/Bucharest" });
cron.schedule("0 8 * * 1",   sendWeeklyReport, { timezone: "Europe/Bucharest" });

console.log("🔍 Prospecting Bot pornit — monitorizare la 30 min, stats zilnice 9:00, raport luni 8:00");

// Rulare imediată la startup
setTimeout(runProspecting, 5000);

module.exports = { runProspecting, sendManualStats, sendWeeklyReport };
