require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { generateHighlights, applyOverlayToImage } = require("./imageOverlay");
const FormData = require("form-data");
const store = require("./dashboardStore");
const postQueue = require("./postQueue");
// Bot modules — încărcate o singură dată (Node cache previne duplicate cron)
const { approvePost: mktApprove, rejectPost: mktReject, runMarketingPost } = require("./marketingBot");
const { runProspecting } = require("./prospectingBot");

// ─── Dashboard helpers (independent of prospectingBot to avoid double cron) ──
const DASH_ZONES = {
  526:"1 Mai",527:"Aeroport",528:"Bariera Vâlcii",529:"Bordei",
  530:"Brazda lui Novac",531:"Brestei",532:"Bucovăț",533:"Calea București",
  534:"Calea Severinului",2247:"Central",535:"Cernele",536:"Ceț",
  537:"Cornițoiu",538:"Craiovița Nouă",2248:"Est",2249:"Exterior Est",
  2250:"Exterior Nord",2251:"Exterior Sud",2252:"Exterior Vest",539:"Gării",
  540:"George Enescu",541:"Ghercești",542:"Lăpuș",543:"Lăpuș Argeș",
  544:"Lascăr Catargiu",545:"Lunca",546:"Matei Basarab",547:"Mofleni",
  548:"Nisipului",2253:"Nord",2254:"Nord-Est",2255:"Nord-Vest",
  2256:"Periferie",549:"Plaiul Vulcănești",550:"Popoveni",551:"Romanești",
  552:"Rovine",553:"Sărari",554:"Siloz",555:"Sineasca",2257:"Sud",
  2258:"Sud-Est",2259:"Sud-Vest",556:"Titulescu",2260:"Ultracentral",
  557:"Valea Roșie",2261:"Vest",
};

async function dashFetchAll(path) {
  const results = [];
  let url = `${CRM_BASE}${path}`;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Token ${CRM_TOKEN}` } });
    if (!r.ok) break;
    const data = await r.json();
    if (data.results) results.push(...data.results);
    url = data.next || null;
  }
  return results;
}

function dashCalcZoneStats(props) {
  const byZone = {};
  for (const p of props) {
    let ppsm = p.price_sqm_sale && p.price_sqm_sale > 100 ? Math.round(p.price_sqm_sale) : null;
    if (!ppsm) {
      const surface = p.surface_useable || p.surface_built;
      if (p.price_sale && surface && surface >= 10) ppsm = Math.round(p.price_sale / surface);
    }
    if (!ppsm || ppsm < 100 || ppsm > 10000 || !p.zone) continue;
    if (!byZone[p.zone]) byZone[p.zone] = [];
    byZone[p.zone].push(ppsm);
  }
  const stats = {};
  for (const [zoneId, prices] of Object.entries(byZone)) {
    if (prices.length < 2) continue;
    const sorted = [...prices].sort((a, b) => a - b);
    stats[zoneId] = {
      name: DASH_ZONES[zoneId] || `Zona ${zoneId}`,
      avg: Math.round(prices.reduce((s, v) => s + v, 0) / prices.length),
      min: sorted[0],
      max: sorted[sorted.length - 1],
      count: prices.length,
    };
  }
  return stats;
}

const OVERLAY_DIR = process.platform === "win32"
  ? path.join(os.tmpdir(), "overlays")
  : "/tmp/overlays";

fs.mkdirSync(OVERLAY_DIR, { recursive: true });

// Cleanup overlay files older than 1 hour on startup
try {
  const cutoff = Date.now() - 3600000;
  fs.readdirSync(OVERLAY_DIR).forEach(f => {
    const fp = path.join(OVERLAY_DIR, f);
    try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch {}
  });
} catch {}

function cleanupBatch(batchId) {
  if (!batchId) return;
  try {
    fs.readdirSync(OVERLAY_DIR)
      .filter(f => f.startsWith(batchId))
      .forEach(f => { try { fs.unlinkSync(path.join(OVERLAY_DIR, f)); } catch {} });
  } catch {}
}

// Upload photo to Facebook — binary upload (works from localhost too)
async function uploadFBPhoto(imgUrl, pageId, pageToken, options = {}) {
  const { published = false, caption } = options;
  const localFile = imgUrl.includes("/overlays/")
    ? path.join(OVERLAY_DIR, imgUrl.split("/overlays/").pop())
    : null;

  if (localFile && fs.existsSync(localFile)) {
    const form = new FormData();
    form.append("source", fs.createReadStream(localFile), { filename: "photo.jpg", contentType: "image/jpeg" });
    form.append("published", String(published));
    if (caption) form.append("caption", caption);
    form.append("access_token", pageToken);
    const r = await fetch(`https://graph.facebook.com/v18.0/${pageId}/photos`, {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });
    return r.json();
  }

  // Remote URL (CRM images or Railway public URLs)
  const r = await fetch(`https://graph.facebook.com/v18.0/${pageId}/photos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: imgUrl, published, caption, access_token: pageToken }),
  });
  return r.json();
}

const app = express();
app.use(cors());
app.use(express.json());
app.use("/overlays", express.static(OVERLAY_DIR));

const CRM_TOKEN = process.env.CRM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const CRM_BASE = "https://simpluimobiliare.crmrebs.com/api";

const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const FB_PAGE_ID = process.env.FB_PAGE_ID;
const IG_ACCOUNT_ID = process.env.IG_ACCOUNT_ID;

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

const PROMPTS = {
  facebook: (info) => `Ești agent imobiliar profesionist la SIMPLU Imobiliare Craiova. Scrie o postare Facebook captivantă și energică. Începe OBLIGATORIU cu una din aceste variante: "✨ SIMPLU Imobiliare prezintă..." sau "✨ Noua noastră ofertă..." sau "🏠 SIMPLU Imobiliare vă propune...". NU folosi niciodată adresări de tipul "Dragi prieteni", "Bună ziua", "Bună" sau alte salutări. Include multe emoji-uri relevante și detaliile cheie ale proprietății. Termină textul cu exact: "Totul este mai SIMPLU cu noi! 😊". După textul principal adaugă minim 10 hashtag-uri în română și engleză relevante pentru imobiliare și Craiova (ex: #imobiliare #craiova #apartament #realestate etc.). NU include număr de telefon, date de contact sau cuvântul "showroom". Scrie toate cuvintele complet, fără abrevieri. Max 400 cuvinte.\n\nProprietate:\n${info}`,
  instagram: (info) => `Ești agent imobiliar profesionist la SIMPLU Imobiliare Craiova. Scrie o postare Instagram captivantă. Începe OBLIGATORIU cu: "✨ SIMPLU Imobiliare prezintă..." sau "✨ Noua noastră ofertă...". NU folosi niciodată adresări de tipul "Dragi prieteni", "Bună ziua" sau alte salutări. Include emoji-uri și minim 15 hashtag-uri română+engleză. Termină textul (înainte de hashtag-uri) cu exact: "Totul este mai SIMPLU cu noi! 😊". NU include număr de telefon, date de contact sau cuvântul "showroom". Scrie toate cuvintele complet, fără abrevieri. Max 300 cuvinte.\n\nProprietate:\n${info}`,
  tiktok: (info) => `Ești agent imobiliar profesionist la SIMPLU Imobiliare Craiova. Scrie un script TikTok scurt și energic. Începe OBLIGATORIU cu un hook puternic legat de proprietate, fără salutări. NU folosi "Bună", "Salut" sau alte adresări. Termină cu exact: "Totul este mai SIMPLU cu noi! 😊". NU include număr de telefon, date de contact sau cuvântul "showroom". Scrie toate cuvintele complet, fără abrevieri. Max 200 cuvinte + hashtag-uri.\n\nProprietate:\n${info}`,
  whatsapp: (info) => `Ești agent imobiliar profesionist la SIMPLU Imobiliare Craiova. Scrie un mesaj WhatsApp profesional. Începe OBLIGATORIU cu: "👋 SIMPLU Imobiliare vă propune..." sau "👋 SIMPLU Imobiliare vă prezintă...". NU folosi niciodată adresări de tipul "Dragi prieteni", "Bună ziua" sau alte salutări. Termină cu exact: "Totul este mai SIMPLU cu noi! 😊". NU include număr de telefon, date de contact sau cuvântul "showroom". Scrie toate cuvintele complet, fără abrevieri. Max 200 cuvinte.\n\nProprietate:\n${info}`,
};

// GET properties from CRM
app.get("/api/properties", async (req, res) => {
  try {
    const page = req.query.page || 1;
    const search = req.query.search || "";
    // Support search by CP id (e.g. CP2962555 or just 2962555)
    const cleanSearch = search.replace(/^CP/i, '').trim();
    let url = `${CRM_BASE}/properties/?ordering=-created_at&limit=20&page=${page}&availability=1&token=${CRM_TOKEN}`;
    if (cleanSearch) url += `&search=${encodeURIComponent(cleanSearch)}`;
    const response = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!response.ok) throw new Error(`CRM error: ${response.status}`);
    const data = await response.json();

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET images for a property
app.get("/api/properties/:id/images", async (req, res) => {
  try {
    const url = `${CRM_BASE}/properties/${req.params.id}/images/?token=${CRM_TOKEN}`;
    const response = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!response.ok) throw new Error(`CRM error: ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST generate social media posts (streaming)
app.post("/api/generate", async (req, res) => {
  const { property, platform } = req.body;
  if (!property || !platform) return res.status(400).json({ error: "Lipsesc parametrii" });

  const info = buildSummary(property);
  const prompt = PROMPTS[platform]?.(info);
  if (!prompt) return res.status(400).json({ error: "Platformă invalidă" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": ANTHROPIC_KEY,
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      res.write(`data: ${JSON.stringify({ error: err.error?.message || "Eroare API" })}\n\n`);
      return res.end();
    }

    const reader = response.body;
    const CONTACT_FOOTER = "\n\n---\n📞 0775 129 022\n🏢 SIMPLU Imobiliare Craiova\n📍 Craiova, Str. Dimitrie Bolintineanu Nr.14\n🌐 SIMPLUIMOBILIARE.COM";
    let messageStopped = false;
    reader.on("data", (chunk) => {
      const lines = chunk.toString().split("\n").filter(l => l.startsWith("data: "));
      for (const line of lines) {
        try {
          const json = JSON.parse(line.slice(6));
          if (json.type === "content_block_delta" && json.delta?.text) {
            res.write(`data: ${JSON.stringify({ text: json.delta.text })}\n\n`);
          }
          if (json.type === "message_stop" && !messageStopped) {
            messageStopped = true;
            res.write(`data: ${JSON.stringify({ text: CONTACT_FOOTER })}\n\n`);
            res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          }
        } catch {}
      }
    });
    reader.on("end", () => res.end());
    reader.on("error", (e) => {
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
      res.end();
    });
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});

// POST process images with yellow text overlays
app.post("/api/overlay-images", async (req, res) => {
  const { imageUrls, property } = req.body;
  if (!imageUrls || imageUrls.length === 0) return res.status(400).json({ error: "Lipsesc imaginile" });
  try {
    const highlights = await generateHighlights(property || {}, imageUrls.length, ANTHROPIC_KEY);
    const batchId = crypto.randomUUID();
    await Promise.all(imageUrls.map((url, i) =>
      applyOverlayToImage(url, highlights[i] || "SIMPLU Imobiliare", path.join(OVERLAY_DIR, `${batchId}_${i}.jpg`))
    ));
    const baseUrl = req.protocol + "://" + req.get("host");
    const overlayUrls = imageUrls.map((_, i) => `${baseUrl}/overlays/${batchId}_${i}.jpg`);
    res.json({ overlayUrls, batchId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST publish to Facebook (multi-photo)
app.post("/api/publish/facebook", async (req, res) => {
  const { message, imageUrls, batchId } = req.body;
  if (!message) return res.status(400).json({ error: "Lipsește mesajul" });
  try {
    const photos = imageUrls && imageUrls.length > 0 ? imageUrls.slice(0, 6) : [];

    if (photos.length > 1) {
      // Upload photos as unpublished, then attach to post
      const photoIds = [];
      for (const imgUrl of photos) {
        const d = await uploadFBPhoto(imgUrl, FB_PAGE_ID, FB_PAGE_TOKEN, { published: false });
        if (d.id) photoIds.push({ media_fbid: d.id });
      }
      const postRes = await fetch(`https://graph.facebook.com/v18.0/${FB_PAGE_ID}/feed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, attached_media: photoIds, published: true, access_token: FB_PAGE_TOKEN }),
      });
      const postData = await postRes.json();
      if (postData.error) return res.status(400).json({ error: postData.error.message });
      cleanupBatch(batchId);
      res.json({ success: true, id: postData.id });
    } else if (photos.length === 1) {
      const d = await uploadFBPhoto(photos[0], FB_PAGE_ID, FB_PAGE_TOKEN, { published: true, caption: message });
      if (d.error) return res.status(400).json({ error: d.error.message });
      cleanupBatch(batchId);
      res.json({ success: true, id: d.id });
    } else {
      const r = await fetch(`https://graph.facebook.com/v18.0/${FB_PAGE_ID}/feed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, access_token: FB_PAGE_TOKEN }),
      });
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      res.json({ success: true, id: d.id });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST publish to Instagram (carousel cu max 10 poze)
app.post("/api/publish/instagram", async (req, res) => {
  const { message, imageUrls, batchId, fallbackUrls } = req.body;
  if (!message || !imageUrls || imageUrls.length === 0) {
    return res.status(400).json({ error: "Instagram necesită mesaj și cel puțin o imagine" });
  }
  try {
    // Instagram API needs public URLs — use fallback CRM URLs if overlays are on localhost
    const isLocalhost = imageUrls[0] && (imageUrls[0].includes("localhost") || imageUrls[0].includes("127.0.0.1"));
    const resolvedUrls = isLocalhost && fallbackUrls && fallbackUrls.length > 0 ? fallbackUrls : imageUrls;
    const photos = resolvedUrls.slice(0, 10);

    if (photos.length === 1) {
      // Single image post
      const containerRes = await fetch(`https://graph.facebook.com/v18.0/${IG_ACCOUNT_ID}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_url: photos[0], caption: message, access_token: FB_PAGE_TOKEN }),
      });
      const container = await containerRes.json();
      if (container.error) return res.status(400).json({ error: container.error.message });
      const publishRes = await fetch(`https://graph.facebook.com/v18.0/${IG_ACCOUNT_ID}/media_publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creation_id: container.id, access_token: FB_PAGE_TOKEN }),
      });
      const published = await publishRes.json();
      if (published.error) return res.status(400).json({ error: published.error.message });
      cleanupBatch(batchId);
      res.json({ success: true, id: published.id });
    } else {
      // Carousel post
      const childIds = [];
      for (const imgUrl of photos) {
        const r = await fetch(`https://graph.facebook.com/v18.0/${IG_ACCOUNT_ID}/media`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_url: imgUrl, is_carousel_item: true, access_token: FB_PAGE_TOKEN }),
        });
        const d = await r.json();
        if (d.id) childIds.push(d.id);
      }
      const carouselRes = await fetch(`https://graph.facebook.com/v18.0/${IG_ACCOUNT_ID}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ media_type: "CAROUSEL", children: childIds.join(","), caption: message, access_token: FB_PAGE_TOKEN }),
      });
      const carousel = await carouselRes.json();
      if (carousel.error) return res.status(400).json({ error: carousel.error.message });
      const publishRes = await fetch(`https://graph.facebook.com/v18.0/${IG_ACCOUNT_ID}/media_publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creation_id: carousel.id, access_token: FB_PAGE_TOKEN }),
      });
      const published = await publishRes.json();
      if (published.error) return res.status(400).json({ error: published.error.message });
      cleanupBatch(batchId);
      res.json({ success: true, id: published.id });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET Facebook page analytics
app.get("/api/analytics/facebook", async (req, res) => {
  try {
    const url = `https://graph.facebook.com/v18.0/${FB_PAGE_ID}/insights?metric=page_impressions,page_reach,page_post_engagements,page_fan_adds&period=day&access_token=${FB_PAGE_TOKEN}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug: list all Facebook pages accessible with current token
app.get("/api/fb-debug", async (req, res) => {
  try {
    const r = await fetch(`https://graph.facebook.com/v18.0/me/accounts?access_token=${FB_PAGE_TOKEN}`);
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message, hint: "Token invalid sau expirat" });
    const pages = (data.data || []).map(p => ({ id: p.id, name: p.name, category: p.category, tasks: p.tasks }));
    res.json({
      current_FB_PAGE_ID: FB_PAGE_ID,
      pages_found: pages,
      hint: pages.length ? "Copiaza 'id'-ul paginii tale si pune-l in Railway ca FB_PAGE_ID" : "Nu s-a gasit nicio pagina — tokenul poate fi User token, nu Page token"
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Dashboard API ────────────────────────────────────────────────────────────

// GET market stats — returnează cache din prospectingBot (instant), fallback la CRM dacă nu e disponibil
app.get("/api/dashboard/market", async (req, res) => {
  // Cache disponibil (prospectingBot a rulat deja)
  if (store.market) {
    return res.json(store.market);
  }
  // Prima deschidere după deploy — fetch rapid (primele 3 pagini = ~300 proprietăți)
  try {
    const fetchPage = (url) => {
      const sep = url.includes("?") ? "&" : "?";
      return fetch(`${url}${sep}token=${CRM_TOKEN}`).then(r => r.json());
    };
    const first = await fetchPage(`${CRM_BASE}/properties/?availability=1&limit=100`);
    let props = first.results || [];
    if (first.next) {
      const second = await fetchPage(first.next);
      props = props.concat(second.results || []);
      if (second.next) {
        const third = await fetchPage(second.next);
        props = props.concat(third.results || []);
      }
    }
    const reqFirst = await fetchPage(`${CRM_BASE}/requests/?availability=2&city=5708&limit=1`);
    const stats = dashCalcZoneStats(props);
    const marketStats = {};
    for (const [zoneId, s] of Object.entries(stats)) {
      marketStats[zoneId] = { name: DASH_ZONES[zoneId] || `Zona ${zoneId}`, ...s };
    }
    res.json({
      stats: marketStats,
      propCount: first.count || props.length,
      requestCount: reqFirst.count || 0,
      time: new Date().toISOString(),
      partial: true, // indică că sunt doar primele 300 proprietăți
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET recent alerts (from in-memory store)
app.get("/api/dashboard/alerts", (req, res) => {
  res.json(store.alerts);
});

// GET bot activity (status + stats per bot)
app.get("/api/dashboard/bot-activity", (req, res) => {
  res.json(store.botActivity);
});

// GET marketing pending posts
app.get("/api/dashboard/marketing/pending", (req, res) => {
  const posts = [];
  for (const [postId, post] of postQueue.entries()) {
    posts.push({
      postId,
      previewUrl: `/overlays/${path.basename(post.imagePath)}`,
      headline: post.headline,
      facebook: post.facebook,
      instagram: post.instagram,
      category: post.category,
      timestamp: post.timestamp,
    });
  }
  posts.sort((a, b) => b.timestamp - a.timestamp);
  res.json(posts);
});

// POST approve marketing post
app.post("/api/dashboard/marketing/approve/:postId", async (req, res) => {
  const result = await mktApprove(req.params.postId);
  res.json(result);
});

// POST reject marketing post
app.post("/api/dashboard/marketing/reject/:postId", async (req, res) => {
  await mktReject(req.params.postId);
  res.json({ ok: true });
});

// POST trigger marketing post generation
app.post("/api/bot/marketing/trigger", (req, res) => {
  res.json({ ok: true, message: "Generare postare marketing în curs..." });
  runMarketingPost().catch(e => console.error("[dashboard] marketing trigger:", e.message));
});

// POST trigger prospecting scan
app.post("/api/bot/prospecting/trigger", (req, res) => {
  res.json({ ok: true, message: "Scanare piață în curs..." });
  runProspecting().catch(e => console.error("[dashboard] prospecting trigger:", e.message));
});

// Serve frontend
app.use(express.static("public"));
app.use(express.static("."));
app.get("*", (req, res) => {
  const fs = require("fs");
  const publicPath = path.join(__dirname, "public", "index.html");
  const rootPath = path.join(__dirname, "index.html");
  if (fs.existsSync(publicPath)) {
    res.sendFile(publicPath);
  } else {
    res.sendFile(rootPath);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server pornit pe portul ${PORT}`));
