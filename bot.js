const https = require("https");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8603536660:AAGv-S9wGidUH8ggAoJCM8WCc3XgmTBNopA";
const CRM_TOKEN = process.env.CRM_TOKEN || "8b5b5946671da2a80fc41481760673ab2868ba99";
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || "";
const CRM_BASE = "https://simpluimobiliare.crmrebs.com/api";

const PROP_TYPES = {1:"Apartament",2:"Casă",3:"Teren",4:"Spațiu comercial",5:"Birou",6:"Depozit",7:"Hotel"};
const APT_TYPES = {1:"Garsonieră",2:"2 camere",3:"3 camere",4:"4+ camere"};

function getType(p) {
  if (p.property_type === 1 && p.apartment_type) return APT_TYPES[p.apartment_type] || "Apartament";
  return PROP_TYPES[p.property_type] || "Proprietate";
}

function buildSummary(p) {
  return [
    `Titlu: ${p.title || "N/A"}`,
    `Tip: ${getType(p)}`,
    `Tranzacție: ${p.transaction_type === 2 ? "Închiriere" : "Vânzare"}`,
    `Preț: ${p.price_sale ? Number(p.price_sale).toLocaleString("ro-RO") + " EUR" : p.price_rent ? Number(p.price_rent).toLocaleString("ro-RO") + " EUR/lună" : "La cerere"}`,
    `Suprafață: ${p.surface_useful || p.surface_built || "N/A"} mp`,
    `Camere: ${p.rooms || "N/A"}`,
    `Etaj: ${p.floor != null ? p.floor : "N/A"}`,
    `An construcție: ${p.construction_year || "N/A"}`,
    `Descriere: ${p.description ? p.description.substring(0, 600) : "N/A"}`,
  ].join("\n");
}

const PLATFORM_NAMES = {facebook:"Facebook",instagram:"Instagram",tiktok:"TikTok",whatsapp:"WhatsApp"};

const PROMPTS = {
  facebook: (info) => `Ești agent imobiliar profesionist la SIMPLU Imobiliare Craiova. Scrie o postare Facebook profesională și convingătoare. Începe OBLIGATORIU cu una din aceste variante: "🏠 SIMPLU Imobiliare vă prezintă cu plăcere..." sau "🏠 SIMPLU Imobiliare vă propune spre achiziție..." sau "🏠 Echipa SIMPLU Imobiliare vă prezintă...". NU folosi adresări de tipul "Dragi prieteni", "Bună ziua" sau alte salutări. Include emoji-uri relevante și detaliile cheie. Termină cu exact: "Totul este mai SIMPLU cu noi! 😊". NU include număr de telefon, date de contact sau cuvântul "showroom". Scrie toate cuvintele complet, fără abrevieri. Max 400 cuvinte.\n\nProprietate:\n${info}`,
  instagram: (info) => `Ești agent imobiliar profesionist la SIMPLU Imobiliare Craiova. Scrie o postare Instagram captivantă. Începe OBLIGATORIU cu: "✨ SIMPLU Imobiliare prezintă..." sau "✨ Noua noastră ofertă...". NU folosi adresări de tipul "Dragi prieteni", "Bună ziua" sau alte salutări. Include emoji-uri și minim 15 hashtag-uri română+engleză. Termină textul (înainte de hashtag-uri) cu exact: "Totul este mai SIMPLU cu noi! 😊". NU include număr de telefon, date de contact sau cuvântul "showroom". Scrie toate cuvintele complet, fără abrevieri. Max 300 cuvinte.\n\nProprietate:\n${info}`,
  tiktok: (info) => `Ești agent imobiliar profesionist la SIMPLU Imobiliare Craiova. Scrie un script TikTok scurt și energic. Începe OBLIGATORIU cu un hook puternic legat de proprietate, fără salutări. NU folosi "Bună", "Salut" sau alte adresări. Termină cu exact: "Totul este mai SIMPLU cu noi! 😊". NU include număr de telefon, date de contact sau cuvântul "showroom". Scrie toate cuvintele complet, fără abrevieri. Max 200 cuvinte + hashtag-uri.\n\nProprietate:\n${info}`,
  whatsapp: (info) => `Ești agent imobiliar profesionist la SIMPLU Imobiliare Craiova. Scrie un mesaj WhatsApp profesional. Începe OBLIGATORIU cu: "👋 SIMPLU Imobiliare vă propune..." sau "👋 SIMPLU Imobiliare vă prezintă...". NU folosi adresări de tipul "Dragi prieteni", "Bună ziua" sau alte salutări. Termină cu exact: "Totul este mai SIMPLU cu noi! 😊". NU include număr de telefon, date de contact sau cuvântul "showroom". Scrie toate cuvintele complet, fără abrevieri. Max 200 cuvinte.\n\nProprietate:\n${info}`,
};

const CONTACT_FOOTER = "\n\n---\n📞 0775 129 022\n🏢 SIMPLU Imobiliare Craiova\n📍 Craiova, Str. Dimitrie Bolintineanu Nr.14\n🌐 SIMPLUIMOBILIARE.COM";

// HTTP helpers
function apiRequest(hostname, path, method = "GET", data = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method, headers: { "Content-Type": "application/json", ...headers } };
    if (data) {
      const body = JSON.stringify(data);
      options.headers["Content-Length"] = Buffer.byteLength(body);
    }
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { resolve(body); }
      });
    });
    req.on("error", reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

function sendTelegram(chatId, text, extra = {}) {
  const msg = text.length > 4096 ? text.substring(0, 4090) + "..." : text;
  return apiRequest("api.telegram.org", `/bot${BOT_TOKEN}/sendMessage`, "POST", {
    chat_id: chatId, text: msg, parse_mode: "HTML", ...extra
  });
}

async function fetchCRM(path) {
  return new Promise((resolve, reject) => {
    const url = `${CRM_BASE}${path}${path.includes("?") ? "&" : "?"}token=${CRM_TOKEN}`;
    const urlObj = new URL(url);
    const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, headers: { "Accept": "application/json" } };
    https.get(options, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("Parse error")); } });
    }).on("error", reject);
  });
}

async function generatePost(platform, property) {
  const info = buildSummary(property);
  const prompt = PROMPTS[platform](info);
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    });
    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": ANTHROPIC_KEY,
        "Content-Length": Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const text = json.content?.[0]?.text || "Eroare la generare.";
          resolve(text + CONTACT_FOOTER);
        } catch { reject(new Error("Parse error")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Command handlers
function formatPropLine(p, i) {
  const price = p.price_sale ? Number(p.price_sale).toLocaleString("ro-RO") + " EUR"
              : p.price_rent ? Number(p.price_rent).toLocaleString("ro-RO") + " EUR/lună" : "La cerere";
  return `${i+1}. <b>${p.display_id || "CP"+p.id}</b> — ${getType(p)}\n   📍 ${p.title || p.street || "N/A"}\n   💰 ${price}\n\n`;
}

async function handleLista(chatId) {
  await sendTelegram(chatId, "⏳ Caut ultimele proprietăți adăugate...");
  try {
    const [saleData, rentData] = await Promise.all([
      fetchCRM("/properties/?ordering=-id&limit=5&availability=1&transaction_type=1"),
      fetchCRM("/properties/?ordering=-id&limit=5&availability=1&transaction_type=2"),
    ]);
    const sale = saleData.results || [];
    const rent = rentData.results || [];
    if (!sale.length && !rent.length) return sendTelegram(chatId, "Nu s-au găsit proprietăți active.");

    let msg = `🏠 <b>Ultimele proprietăți adăugate:</b>\n\n`;
    if (sale.length) {
      msg += `🔑 <b>DE VÂNZARE (${saleData.count} total)</b>\n`;
      sale.forEach((p, i) => { msg += formatPropLine(p, i); });
    }
    if (rent.length) {
      msg += `🏷️ <b>DE ÎNCHIRIERE (${rentData.count} total)</b>\n`;
      rent.forEach((p, i) => { msg += formatPropLine(p, i); });
    }
    msg += `💡 <b>/post CP[id] facebook</b> — generează postare\n💡 <b>/cauta vanzare [cuvinte]</b> sau <b>/cauta inchiriere [cuvinte]</b>`;
    await sendTelegram(chatId, msg);
  } catch(e) {
    await sendTelegram(chatId, `❌ Eroare: ${e.message}`);
  }
}

async function handleCauta(chatId, query) {
  if (!query) return sendTelegram(chatId, "❌ Specifică un termen de căutare.\nExemplu: <b>/cauta garsoniera</b> sau <b>/cauta CP2962555</b>");
  await sendTelegram(chatId, `⏳ Caut proprietăți pentru "<b>${query}</b>"...`);
  try {
    // Dacă e un ID (CP123 sau doar cifre), caută direct după display_id
    const idMatch = query.match(/^CP?(\d+)$/i);
    if (idMatch) {
      const numId = idMatch[1];
      // Încearcă căutare directă după ID numeric
      const byId = await fetchCRM(`/properties/${numId}/`);
      if (!byId.detail && byId.id) {
        const p = byId;
        const price = p.price_sale ? Number(p.price_sale).toLocaleString("ro-RO") + " EUR"
                    : p.price_rent ? Number(p.price_rent).toLocaleString("ro-RO") + " EUR/lună" : "La cerere";
        const meta = [p.surface_useful && p.surface_useful + " mp", p.rooms && p.rooms + " cam.", p.floor != null && "et." + p.floor].filter(Boolean).join(" · ");
        let msg = `🏠 <b>${p.display_id || "CP"+p.id}</b> — ${getType(p)}\n\n`;
        msg += `📍 ${p.title || p.street || "N/A"}\n`;
        msg += `💰 ${price}\n`;
        if (meta) msg += `📐 ${meta}\n`;
        if (p.description) msg += `\n📝 ${p.description.substring(0, 400)}${p.description.length > 400 ? "..." : ""}\n`;
        msg += `\n💡 <b>/post ${p.display_id || "CP"+p.id} facebook</b> — generează postare`;
        return sendTelegram(chatId, msg);
      }
      // Fallback la căutare text
      const data = await fetchCRM(`/properties/?ordering=-id&limit=10&availability=1&search=${encodeURIComponent(numId)}`);
      const props = data.results || [];
      if (!props.length) return sendTelegram(chatId, `❌ Nu am găsit proprietatea cu ID-ul ${query}.`);
      return sendTelegram(chatId, formatSearchResults(query, props, data.count));
    }

    // Detectează filtru vânzare/închiriere din query
    let txFilter = "";
    let cleanedQuery = query;
    if (/\b(vanzare|vânzare|vinde|sale)\b/i.test(query)) {
      txFilter = "&transaction_type=1";
      cleanedQuery = query.replace(/\b(vanzare|vânzare|vinde|sale)\b/gi, "").trim();
    } else if (/\b(inchiriere|închiriere|chirie|rent)\b/i.test(query)) {
      txFilter = "&transaction_type=2";
      cleanedQuery = query.replace(/\b(inchiriere|închiriere|chirie|rent)\b/gi, "").trim();
    }

    const searchParam = cleanedQuery ? `&search=${encodeURIComponent(cleanedQuery)}` : "";
    const data = await fetchCRM(`/properties/?ordering=-id&limit=10&availability=1${txFilter}${searchParam}`);
    const props = data.results || [];
    if (!props.length) return sendTelegram(chatId, `Nu s-au găsit proprietăți pentru "<b>${query}</b>".\n\nÎncearcă cu: garsoniera, apartament, casa, teren, vanzare, inchiriere etc.`);
    await sendTelegram(chatId, formatSearchResults(query, props, data.count));
  } catch(e) {
    await sendTelegram(chatId, `❌ Eroare: ${e.message}`);
  }
}

function formatSearchResults(query, props, total) {
  let msg = `🔍 <b>Rezultate pentru "${query}"</b> (${total || props.length} găsite):\n\n`;
  props.forEach((p, i) => {
    const price = p.price_sale ? Number(p.price_sale).toLocaleString("ro-RO") + " EUR"
                : p.price_rent ? Number(p.price_rent).toLocaleString("ro-RO") + " EUR/lună" : "La cerere";
    msg += `${i+1}. <b>${p.display_id || "CP"+p.id}</b> — ${getType(p)}\n`;
    msg += `   📍 ${p.title || p.street || "N/A"}\n`;
    msg += `   💰 ${price}\n\n`;
  });
  msg += `💡 <b>/post CP[id] facebook</b> — generează postare`;
  return msg;
}

async function handlePost(chatId, cpId, platform) {
  if (!cpId) return sendTelegram(chatId, "❌ Specifică ID-ul proprietății.\nExemplu: <b>/post CP2962555 facebook</b>");
  const platforms = platform === "toate" ? ["facebook","instagram","tiktok","whatsapp"] : [platform];
  const validPlatforms = ["facebook","instagram","tiktok","whatsapp","toate"];
  if (!validPlatforms.includes(platform)) {
    return sendTelegram(chatId, "❌ Platformă invalidă. Folosește: <b>facebook</b>, <b>instagram</b>, <b>tiktok</b>, <b>whatsapp</b> sau <b>toate</b>");
  }
  const propId = cpId.replace(/^CP/i, "");
  await sendTelegram(chatId, `⏳ Generez postare pentru <b>${cpId.toUpperCase()}</b> pe <b>${platform}</b>...`);
  try {
    const prop = await fetchCRM(`/properties/${propId}/`);
    if (prop.detail) return sendTelegram(chatId, `❌ Proprietatea ${cpId} nu a fost găsită.`);
    for (const plat of platforms) {
      await sendTelegram(chatId, `✍️ Generez pentru <b>${PLATFORM_NAMES[plat]}</b>...`);
      const text = await generatePost(plat, prop);
      await sendTelegram(chatId, `📱 <b>${PLATFORM_NAMES[plat]}:</b>\n\n${text}`);
    }
  } catch(e) {
    await sendTelegram(chatId, `❌ Eroare: ${e.message}`);
  }
}

async function handleStart(chatId) {
  const msg = `🏠 <b>SIMPLU Imobiliare Bot</b>

Bun venit! Iată ce pot face:

/lista — Ultimele 5 vânzări + 5 închirieri
/cauta [termen] — Caută proprietăți
/post [CP] [platformă] — Generează postare

<b>Exemple căutare:</b>
/cauta CP2962555
/cauta garsoniera
/cauta vanzare 3 camere
/cauta inchiriere ultracentral
/cauta casa 4 camere

<b>Exemple postare:</b>
/post CP2962555 facebook
/post CP2962555 instagram
/post CP2962555 toate

<i>Totul este mai SIMPLU cu noi! 😊</i>`;
  await sendTelegram(chatId, msg);
}

// Polling
let lastUpdateId = 0;
let _marketing = null;
function getMarketing() {
  if (!_marketing) _marketing = require("./marketingBot");
  return _marketing;
}

async function poll() {
  try {
    const data = await apiRequest("api.telegram.org", `/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`);
    if (data.ok && data.result?.length) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;

        // Inline keyboard callbacks (aprobare/respingere postări marketing)
        if (update.callback_query) {
          const cb = update.callback_query;
          const cbData = cb.data || "";
          const cbChatId = cb.message?.chat?.id;
          if (cbData.startsWith("mkt_ok_")) {
            const postId = cbData.slice(7);
            const result = await getMarketing().approvePost(postId, cbChatId);
            await apiRequest("api.telegram.org", `/bot${BOT_TOKEN}/answerCallbackQuery`, "POST",
              { callback_query_id: cb.id, text: result.text });
            if (cbChatId) await sendTelegram(cbChatId, result.text);
          } else if (cbData.startsWith("mkt_no_")) {
            const postId = cbData.slice(7);
            getMarketing().rejectPost(postId);
            await apiRequest("api.telegram.org", `/bot${BOT_TOKEN}/answerCallbackQuery`, "POST",
              { callback_query_id: cb.id, text: "❌ Postare respinsă și ștearsă." });
            if (cbChatId) await sendTelegram(cbChatId, "❌ Postarea a fost respinsă.");
          }
          continue;
        }

        const msg = update.message;
        if (!msg?.text) continue;
        const chatId = msg.chat.id;
        const text = msg.text.trim();
        const parts = text.split(/\s+/);
        const cmd = parts[0].toLowerCase().replace("@simplumobiliarebot", "");
        console.log(`[${new Date().toISOString()}] ${chatId}: ${text}`);
        if (cmd === "/start" || cmd === "/help") {
          await handleStart(chatId);
        } else if (cmd === "/lista" || cmd === "/listare") {
          await handleLista(chatId);
        } else if (cmd === "/cauta") {
          await handleCauta(chatId, parts.slice(1).join(" "));
        } else if (cmd === "/post") {
          await handlePost(chatId, parts[1], (parts[2] || "facebook").toLowerCase());
        } else if (cmd === "/testmarketing") {
          await sendTelegram(chatId, "⏳ Generez postare de test...");
          try {
            await getMarketing().runMarketingPost();
          } catch(e) {
            await sendTelegram(chatId, `❌ Eroare: ${e.message}`);
          }
        } else if (cmd === "/piata") {
          await sendTelegram(chatId, "⏳ Calculez statistici piață...");
          try {
            await require("./prospectingBot").sendManualStats(chatId);
          } catch(e) {
            await sendTelegram(chatId, `❌ Eroare: ${e.message}`);
          }
        } else if (cmd === "/raport") {
          await sendTelegram(chatId, "⏳ Generez raport săptămânal...");
          try {
            await require("./prospectingBot").sendWeeklyReport(chatId);
          } catch(e) {
            await sendTelegram(chatId, `❌ Eroare: ${e.message}`);
          }
        } else if (cmd === "/prospecting") {
          await sendTelegram(chatId, "⏳ Rulare monitorizare manuală...");
          try {
            await require("./prospectingBot").runProspecting();
          } catch(e) {
            await sendTelegram(chatId, `❌ Eroare: ${e.message}`);
          }
        } else if (cmd.startsWith("/")) {
          // Ignoră comenzi necunoscute silențios (evită mesaje duble la redeploy)
        }
      }
    }
  } catch(e) {
    console.error("Poll error:", e.message);
  }
  setTimeout(poll, 1000);
}

console.log("🤖 SIMPLU Imobiliare Bot pornit!");
poll();
