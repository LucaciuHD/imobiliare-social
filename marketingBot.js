require("dotenv").config();
const fetch = require("node-fetch");
const cron = require("node-cron");
const sharp = require("sharp");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const os = require("os");
const opentype = require("opentype.js");
const crypto = require("crypto");
const postQueue = require("./postQueue");

const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const FB_PAGE_ID = process.env.FB_PAGE_ID;
const IG_ACCOUNT_ID = process.env.IG_ACCOUNT_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
const PUBLIC_URL = process.env.PUBLIC_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN : null);

const OVERLAY_DIR = process.platform === "win32"
  ? path.join(os.tmpdir(), "overlays")
  : "/tmp/overlays";
fs.mkdirSync(OVERLAY_DIR, { recursive: true });

const LOGO_URL = "https://media.crmrebs.com/agencies/simpluimobiliare/logo/df1af06e-4181-4a4f-bded-cae60a80194c/Logo_Simplu_Imobiliare-01.png";
let _logoBuffer = null;
let _font = null;
const FONT_PATHS = [
  path.join(__dirname, "fonts", "BebasNeue-Regular.otf"),
  path.join(__dirname, "fonts", "NotoSans-Bold.ttf"),
];
for (const fp of FONT_PATHS) {
  try {
    _font = opentype.loadSync(fp);
    console.log("[marketing-font] Loaded:", path.basename(fp));
    break;
  } catch (e) {
    console.warn("[marketing-font] Skip:", path.basename(fp), e.message);
  }
}

const CONTACT_FOOTER = "\n\n📞 0775 129 022\n🏢 SIMPLU Imobiliare Craiova\n📍 Str. Dimitrie Bolintineanu Nr.14\n🌐 SIMPLUIMOBILIARE.COM";

const CATEGORIES = [
  { name: "cumparator_witty",  topic: "frici și greșeli ale cumpărătorilor de imobile — ton ironic, direct, cu umor (fără referințe sezoniere sau de sărbători)" },
  { name: "vanzator_witty",    topic: "greșeli și mituri ale vânzătorilor de imobile — demontate cu umor și directețe" },
  { name: "brand_bold",        topic: "de ce SIMPLU Imobiliare — diferența față de alți agenți, ton bold și anti-corporate" },
  { name: "myth_buster",       topic: "mituri despre imobiliare în România — demontate cu o replică acidă și scurtă" },
  { name: "relatable_moment",  topic: "momente comice recognoscibile pentru oricine caută sau vinde o locuință" },
  { name: "piata_provocator",  topic: "realitatea pieței imobiliare Craiova — insight surprinzător, spus direct" },
];

let _categoryIndex = 0;

async function generateMarketingContent() {
  const category = CATEGORIES[_categoryIndex % CATEGORIES.length];
  _categoryIndex++;

  const prompt = `Ești copywriter de social media pentru SIMPLU Imobiliare Craiova. Brandul are un ton bold, direct, ironic și anti-corporate — ca în exemplele de mai jos.

EXEMPLE DE TON ȘI STIL (inspiră-te, nu copia):
- "Nu vindem iluzii. Găsim locuințe."
- "Singurul stres? Mutatul canapelei."
- "Prețul e corect. Actele sunt clare. Agentul știe ce face."
- "Nu căutăm comision. Căutăm casa potrivită pentru tine."
- "Pozele proaste costă vânzări. Noi știm să prezentăm."
- "Negociezi singur? Mult succes. Sau sună-ne."
- "Ai văzut 10 apartamente și tot nu te-ai decis? Normal. Noi găsim al 11-lea."
- "Un agent bun nu-ți vinde ce are. Îți găsește ce vrei."

Creează o postare despre: ${category.topic}

Răspunde STRICT cu un JSON valid (fără text în afara JSON-ului):
{
  "headline": ["linie1", "linie2"],
  "facebook": "text complet postare Facebook",
  "instagram": "text complet postare Instagram"
}

REGULI headline (OBLIGATORIU):
- Exact 2 linii (nu 3!)
- Scurte și punchline — maxim 5 cuvinte per linie
- Fără emoji în headline — text pur, BOLD vizual
- Pot fi ALL CAPS sau mixte pentru impact
- Exemplu bun: ["Nu vindem iluzii.", "Găsim locuințe."]
- Exemplu bun: ["SINGURUL STRES?", "Mutatul canapelei."]
- NU folosi fraze lungi sau explicații

REGULI facebook:
- Max 150 cuvinte, ton direct și energic, cu 2-3 emoji max
- NU folosi salutări gen "Bună ziua", "Dragi prieteni"
- Începe direct cu o afirmație sau întrebare provocatoare
- Termină cu: "Totul este mai SIMPLU cu noi! 😊"
- 8-10 hashtag-uri relevante la final
- NU include număr de telefon sau adresă

REGULI instagram:
- Max 120 cuvinte, același ton bold și direct, cu 3-5 emoji
- NU folosi salutări gen "Bună ziua", "Dragi prieteni"
- Termină cu: "Totul este mai SIMPLU cu noi! 😊"
- 20 hashtag-uri română+engleză la final
- NU include număr de telefon sau adresă`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": ANTHROPIC_KEY,
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1400,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error("No content from Claude");

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Invalid JSON from Claude");
  const content = JSON.parse(match[0]);

  return {
    category: category.name,
    headline: content.headline || ["✨ SIMPLU Imobiliare", "Experții tăi imobiliari", "din Craiova"],
    facebook: (content.facebook || "Postare Facebook") + CONTACT_FOOTER,
    instagram: (content.instagram || "Postare Instagram") + CONTACT_FOOTER,
  };
}

async function getLogoBuffer() {
  if (_logoBuffer) return _logoBuffer;
  try {
    const r = await fetch(LOGO_URL);
    if (r.ok) _logoBuffer = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    console.error("[marketing] Logo fetch failed:", e.message);
  }
  return _logoBuffer;
}

function makeTextPath(text, cx, cy, fontSize, color) {
  if (!_font) {
    const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<text x="${cx}" y="${cy}" font-size="${fontSize}" fill="${color}" text-anchor="middle" font-weight="bold" font-family="sans-serif">${escaped}</text>`;
  }
  const p = _font.getPath(text, 0, 0, fontSize);
  const bb = p.getBoundingBox();
  const ox = cx - bb.x1 - (bb.x2 - bb.x1) / 2;
  const oy = cy - (bb.y1 + bb.y2) / 2;
  const fp = _font.getPath(text, ox, oy, fontSize);
  const d = fp.commands.map(c => {
    const f = v => v.toFixed(2);
    if (c.type === "M") return `M${f(c.x)},${f(c.y)}`;
    if (c.type === "L") return `L${f(c.x)},${f(c.y)}`;
    if (c.type === "C") return `C${f(c.x1)},${f(c.y1)},${f(c.x2)},${f(c.y2)},${f(c.x)},${f(c.y)}`;
    if (c.type === "Q") return `Q${f(c.x1)},${f(c.y1)},${f(c.x)},${f(c.y)}`;
    if (c.type === "Z") return "Z";
    return "";
  }).join("");
  return `<path d="${d}" fill="${color}"/>`;
}

function measureTextWidth(text, fontSize) {
  if (!_font) return text.length * fontSize * 0.6;
  const p = _font.getPath(text, 0, 0, fontSize);
  const bb = p.getBoundingBox();
  return bb.x2 - bb.x1;
}

function fitFontSize(text, maxWidth, startSize, minSize) {
  let size = startSize;
  while (size > minSize && measureTextWidth(text, size) > maxWidth) {
    size -= 2;
  }
  return size;
}

function makeTextPathLeft(text, x, y, fontSize, color) {
  if (!_font) {
    const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<text x="${x}" y="${y}" font-size="${fontSize}" fill="${color}" font-weight="bold" font-family="sans-serif">${escaped}</text>`;
  }
  const p = _font.getPath(text, x, y, fontSize);
  const d = p.commands.map(c => {
    const f = v => v.toFixed(2);
    if (c.type === "M") return `M${f(c.x)},${f(c.y)}`;
    if (c.type === "L") return `L${f(c.x)},${f(c.y)}`;
    if (c.type === "C") return `C${f(c.x1)},${f(c.y1)},${f(c.x2)},${f(c.y2)},${f(c.x)},${f(c.y)}`;
    if (c.type === "Q") return `Q${f(c.x1)},${f(c.y1)},${f(c.x)},${f(c.y)}`;
    if (c.type === "Z") return "Z";
    return "";
  }).join("");
  return `<path d="${d}" fill="${color}"/>`;
}

// Queries per categorie — fotografii reale ca fundal (loremflickr.com, fără API key)
const CATEGORY_PHOTOS = {
  cumparator_witty:  ["apartment,modern,interior", "living,room,luxury", "home,keys,door"],
  vanzator_witty:    ["house,architecture,modern", "villa,exterior,luxury", "property,real,estate"],
  brand_bold:        ["city,skyline,night", "architecture,building,modern", "urban,lifestyle,street"],
  myth_buster:       ["handshake,business,deal", "contract,office,professional", "keys,house,sale"],
  relatable_moment:  ["moving,boxes,home", "couple,house,happy", "family,home,new"],
  piata_provocator:  ["city,aerial,view", "downtown,buildings,urban", "architecture,cityscape"],
};

async function fetchBackgroundImage(category) {
  const queries = CATEGORY_PHOTOS[category] || ["apartment,modern,interior"];
  const query = queries[Math.floor(Math.random() * queries.length)];
  try {
    const res = await fetch(`https://loremflickr.com/1080/1080/${query}`, {
      redirect: "follow",
      headers: { "User-Agent": "SimpluImobiliare-Bot/1.0" },
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 10000) return buf;
    }
  } catch (e) {
    console.warn("[marketing] Photo fetch failed:", e.message);
  }
  return null;
}

async function generateMarketingImage(headline, category) {
  const W = 1080, H = 1080;
  const PAD = 72;
  const MAX_TEXT_W = W - PAD * 2;
  const layout = _categoryIndex % 4; // 4 layout-uri distincte

  const photoBuf = await fetchBackgroundImage(category || "brand_bold");
  let bg;
  if (photoBuf) {
    bg = await sharp(photoBuf).resize(W, H, { fit: "cover", position: "centre" }).png().toBuffer();
  } else {
    bg = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 17, g: 17, b: 17, alpha: 1 } } }).png().toBuffer();
  }

  const composites = [];
  let svgParts = [];

  // Logo rezervă o zonă de 260x90px în colțul jos-dreapta — textul nu intră acolo
  const LOGO_W = 240, LOGO_ZONE_H = 90;
  // Textul footer stânga se limitează la jumătatea imaginii ca să nu colizioneze cu logo-ul
  const FOOTER_MAX_W = Math.round(W * 0.52);

  // ─────────────────────────────────────────────────────────────
  // LAYOUT 0 — "Cinema": gradient jos, text mare centru-stânga, bara galbenă sus
  // ─────────────────────────────────────────────────────────────
  if (layout === 0) {
    composites.push({ input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
        <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#000" stop-opacity="0.1"/>
          <stop offset="45%" stop-color="#000" stop-opacity="0.5"/>
          <stop offset="100%" stop-color="#000" stop-opacity="0.92"/>
        </linearGradient></defs>
        <rect width="${W}" height="${H}" fill="url(#g)"/>
      </svg>`) });

    svgParts.push(`<rect x="0" y="0" width="${W}" height="10" fill="#FFD700"/>`);
    const textStart = H * 0.42;
    headline.forEach((line, i) => {
      const fs = fitFontSize(line.toUpperCase(), MAX_TEXT_W, 172, 68);
      svgParts.push(makeTextPathLeft(line.toUpperCase(), PAD, textStart + i * 178, fs, "#FFFFFF"));
    });
    // Footer stânga — lățime limitată să nu ajungă la logo
    svgParts.push(`<rect x="${PAD}" y="${H - 162}" width="80" height="6" fill="#FFD700"/>`);
    svgParts.push(makeTextPathLeft("SIMPLU IMOBILIARE", PAD, H - 114, fitFontSize("SIMPLU IMOBILIARE", FOOTER_MAX_W, 40, 24), "#FFD700"));
    svgParts.push(makeTextPathLeft("SIMPLUIMOBILIARE.COM", PAD, H - 68, fitFontSize("SIMPLUIMOBILIARE.COM", FOOTER_MAX_W, 24, 16), "#aaaaaa"));
  }

  // ─────────────────────────────────────────────────────────────
  // LAYOUT 1 — "Split": foto sus 52%, bandă galbenă jos 48%
  // Logo integrat în banda galbenă (nu separat) — fără suprapunere
  // ─────────────────────────────────────────────────────────────
  else if (layout === 1) {
    const yBand = Math.round(H * 0.52);
    composites.push({ input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
        <rect x="0" y="${yBand}" width="${W}" height="${H - yBand}" fill="#FFD700"/>
      </svg>`) });

    // Headline în banda galbenă, text negru, limitat la lățimea totală
    const availH = H - yBand - 120; // lasă 120px sus pentru brand
    const lineH = Math.round(availH / Math.max(headline.length, 1));
    const textStart = yBand + 120;
    headline.forEach((line, i) => {
      const fs = fitFontSize(line.toUpperCase(), MAX_TEXT_W, Math.min(lineH - 10, 148), 48);
      svgParts.push(makeTextPathLeft(line.toUpperCase(), PAD, textStart + i * lineH, fs, "#111111"));
    });
    // Brand mic sus în banda galbenă
    svgParts.push(`<rect x="${PAD}" y="${yBand + 22}" width="60" height="5" fill="#111111"/>`);
    svgParts.push(makeTextPathLeft("SIMPLU IMOBILIARE", PAD, yBand + 64, fitFontSize("SIMPLU IMOBILIARE", FOOTER_MAX_W, 32, 20), "#111111"));
    svgParts.push(makeTextPathLeft("SIMPLUIMOBILIARE.COM", PAD, yBand + 94, fitFontSize("SIMPLUIMOBILIARE.COM", FOOTER_MAX_W, 22, 14), "rgba(0,0,0,0.55)"));
  }

  // ─────────────────────────────────────────────────────────────
  // LAYOUT 2 — "Bold Box": casetă neagră în mijloc cu text, logo jos-dreapta
  // ─────────────────────────────────────────────────────────────
  else if (layout === 2) {
    composites.push({ input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
        <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#000" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="#000" stop-opacity="0.7"/>
        </linearGradient></defs>
        <rect width="${W}" height="${H}" fill="url(#g)"/>
      </svg>`) });

    const boxX = PAD - 20, boxY = Math.round(H * 0.26);
    const boxW = W - (PAD - 20) * 2;
    const boxH = Math.round(H * 0.46);
    svgParts.push(`<rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" fill="rgba(0,0,0,0.78)" rx="4"/>`);
    svgParts.push(`<rect x="${boxX}" y="${boxY}" width="${boxW}" height="6" fill="#FFD700"/>`);
    svgParts.push(`<rect x="${boxX}" y="${boxY + boxH - 6}" width="${boxW}" height="6" fill="#FFD700"/>`);

    const textCenterY = boxY + boxH / 2;
    const totalTextH = headline.length * 168;
    headline.forEach((line, i) => {
      const fs = fitFontSize(line.toUpperCase(), boxW - 80, 158, 58);
      const y = textCenterY - totalTextH / 2 + i * 168 + fs * 0.72;
      svgParts.push(makeTextPathLeft(line.toUpperCase(), boxX + 40, y, fs, "#FFFFFF"));
    });

    // Footer stânga — limitat să nu atingă logo-ul
    svgParts.push(`<rect x="${PAD}" y="${H - 152}" width="70" height="5" fill="#FFD700"/>`);
    svgParts.push(makeTextPathLeft("SIMPLU IMOBILIARE", PAD, H - 106, fitFontSize("SIMPLU IMOBILIARE", FOOTER_MAX_W, 40, 24), "#FFD700"));
    svgParts.push(makeTextPathLeft("SIMPLUIMOBILIARE.COM", PAD, H - 62, fitFontSize("SIMPLUIMOBILIARE.COM", FOOTER_MAX_W, 24, 16), "#aaaaaa"));
  }

  // ─────────────────────────────────────────────────────────────
  // LAYOUT 3 — "Neon": gradient diagonal, text sus, bara galbenă stânga
  // ─────────────────────────────────────────────────────────────
  else {
    composites.push({ input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
        <defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stop-color="#000" stop-opacity="0.92"/>
          <stop offset="60%" stop-color="#000" stop-opacity="0.55"/>
          <stop offset="100%" stop-color="#000" stop-opacity="0.1"/>
        </linearGradient></defs>
        <rect width="${W}" height="${H}" fill="url(#g)"/>
      </svg>`) });

    svgParts.push(`<rect x="0" y="0" width="12" height="${H}" fill="#FFD700"/>`);
    const textStart = Math.round(H * 0.14);
    const lineH = 180;
    headline.forEach((line, i) => {
      const fs = fitFontSize(line.toUpperCase(), MAX_TEXT_W - 40, 172, 64);
      svgParts.push(makeTextPathLeft(line.toUpperCase(), PAD + 20, textStart + i * lineH, fs, "#FFFFFF"));
    });

    // Footer stânga — limitat
    svgParts.push(`<rect x="${PAD + 20}" y="${H - 162}" width="70" height="6" fill="#FFD700"/>`);
    svgParts.push(makeTextPathLeft("SIMPLU IMOBILIARE", PAD + 20, H - 114, fitFontSize("SIMPLU IMOBILIARE", FOOTER_MAX_W, 40, 24), "#FFD700"));
    svgParts.push(makeTextPathLeft("SIMPLUIMOBILIARE.COM", PAD + 20, H - 68, fitFontSize("SIMPLUIMOBILIARE.COM", FOOTER_MAX_W, 24, 16), "#aaaaaa"));
  }

  composites.push({ input: Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` + svgParts.join("") + `</svg>`) });

  // Logo PNG — sus-dreapta (zonă liberă pe toate layout-urile), fundal galben ca brand-ul real
  const logoBuffer = await getLogoBuffer();
  if (logoBuffer) {
    try {
      const resized = await sharp(logoBuffer)
        .flatten({ background: "#FFD700" })
        .resize({ width: 210, fit: "inside" })
        .png()
        .toBuffer({ resolveWithObject: true });
      composites.push({ input: resized.data, top: PAD - 10, left: W - resized.info.width - PAD });
    } catch {}
  }

  const outputPath = path.join(OVERLAY_DIR, `marketing_${Date.now()}.jpg`);
  await sharp(bg).composite(composites).jpeg({ quality: 92 }).toFile(outputPath);
  return outputPath;
}

async function uploadPhotoToFacebook(imagePath, caption) {
  const form = new FormData();
  form.append("source", fs.createReadStream(imagePath), { filename: "marketing.jpg", contentType: "image/jpeg" });
  form.append("caption", caption);
  form.append("published", "true");
  form.append("access_token", FB_PAGE_TOKEN);
  const r = await fetch(`https://graph.facebook.com/v18.0/${FB_PAGE_ID}/photos`, {
    method: "POST", body: form, headers: form.getHeaders(),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.id;
}

async function postToInstagram(imagePublicUrl, caption) {
  const cRes = await fetch(`https://graph.facebook.com/v18.0/${IG_ACCOUNT_ID}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_url: imagePublicUrl, caption, access_token: FB_PAGE_TOKEN }),
  });
  const container = await cRes.json();
  if (container.error) throw new Error("IG container: " + container.error.message);

  const pRes = await fetch(`https://graph.facebook.com/v18.0/${IG_ACCOUNT_ID}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: container.id, access_token: FB_PAGE_TOKEN }),
  });
  const published = await pRes.json();
  if (published.error) throw new Error("IG publish: " + published.error.message);
  return published.id;
}

async function publishPost(postId) {
  const post = postQueue.get(postId);
  if (!post) throw new Error("Post not found: " + postId);

  const fbId = await uploadPhotoToFacebook(post.imagePath, post.facebook);
  console.log(`[marketing] Facebook OK! ID: ${fbId}`);

  if (PUBLIC_URL && IG_ACCOUNT_ID) {
    const filename = path.basename(post.imagePath);
    const igId = await postToInstagram(`${PUBLIC_URL}/overlays/${filename}`, post.instagram);
    console.log(`[marketing] Instagram OK! ID: ${igId}`);
  }

  postQueue.delete(postId);
  setTimeout(() => { try { fs.unlinkSync(post.imagePath); } catch {} }, 5000);
}

async function sendTelegramPreview(imagePath, post, postId) {
  // 1. Trimite poza cu caption scurt (Telegram limitează caption la 1024 chars)
  const shortCaption = `📋 <b>PREVIZUALIZARE</b> — ${post.category}\n🏷 <i>${post.headline.join(" | ")}</i>`;
  const photoForm = new FormData();
  photoForm.append("chat_id", String(ADMIN_CHAT_ID));
  photoForm.append("photo", fs.createReadStream(imagePath), { filename: "preview.jpg", contentType: "image/jpeg" });
  photoForm.append("caption", shortCaption);
  photoForm.append("parse_mode", "HTML");
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: "POST", body: photoForm, headers: photoForm.getHeaders(),
  });

  // 2. Trimite textul complet Facebook ca mesaj separat
  const fbText = `<b>📘 TEXT FACEBOOK:</b>\n\n${post.facebook}`;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: String(ADMIN_CHAT_ID),
      text: fbText.substring(0, 4096),
      parse_mode: "HTML",
    }),
  });

  // 3. Mesaj cu butoanele de aprobare (text Instagram + butoane)
  const igText = `<b>📸 TEXT INSTAGRAM:</b>\n\n${post.instagram.substring(0, 800)}${post.instagram.length > 800 ? "..." : ""}`;
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: String(ADMIN_CHAT_ID),
      text: igText,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Aprobă și publică", callback_data: `mkt_ok_${postId}` },
          { text: "❌ Respinge / Regenerează", callback_data: `mkt_no_${postId}` },
        ]]
      },
    }),
  });
  return r.json();
}

// Called by bot.js when admin approves
async function approvePost(postId, chatId) {
  try {
    await publishPost(postId);
    return { ok: true, text: "✅ Postarea a fost publicată pe Facebook și Instagram!" };
  } catch (e) {
    return { ok: false, text: "❌ Eroare la publicare: " + e.message };
  }
}

// Called by bot.js when admin rejects — regenerează automat alta
async function rejectPost(postId) {
  const post = postQueue.get(postId);
  if (post) {
    setTimeout(() => { try { fs.unlinkSync(post.imagePath); } catch {} }, 1000);
    postQueue.delete(postId);
  }
  // Generează și trimite o postare nouă
  try {
    console.log("[marketing] Postare respinsă — generez alta...");
    const content = await generateMarketingContent();
    const imagePath = await generateMarketingImage(content.headline, content.category);
    const newId = crypto.randomUUID().replace(/-/g, "").substring(0, 16);
    postQueue.set(newId, { ...content, imagePath, timestamp: Date.now() });
    const tgRes = await sendTelegramPreview(imagePath, content, newId);
    if (tgRes.ok) {
      console.log(`[marketing] Nouă postare trimisă pentru aprobare. ID: ${newId}`);
    }
    setTimeout(() => {
      if (postQueue.has(newId)) { rejectPost(newId); }
    }, 2 * 60 * 60 * 1000);
  } catch (e) {
    console.error("[marketing] Eroare la regenerare:", e.message);
  }
}

async function runMarketingPost() {
  try {
    const catName = CATEGORIES[_categoryIndex % CATEGORIES.length].name;
    console.log(`[marketing] Generez postare... (${catName})`);

    const content = await generateMarketingContent();
    const imagePath = await generateMarketingImage(content.headline, content.category);
    console.log(`[marketing] Conținut și imagine generate.`);

    if (ADMIN_CHAT_ID && BOT_TOKEN) {
      // Preview mode — trimite la admin pentru aprobare
      const postId = crypto.randomUUID().replace(/-/g, "").substring(0, 16);
      postQueue.set(postId, { ...content, imagePath, timestamp: Date.now() });

      const tgRes = await sendTelegramPreview(imagePath, content, postId);
      if (tgRes.ok) {
        console.log(`[marketing] Preview trimis pe Telegram. ID: ${postId}`);
      } else {
        console.error("[marketing] Telegram preview failed:", JSON.stringify(tgRes));
        // Fallback: publică automat dacă Telegram nu merge
        await publishPost(postId);
      }

      // Auto-expire după 2 ore dacă nu e aprobat
      setTimeout(() => {
        if (postQueue.has(postId)) {
          console.log(`[marketing] Post ${postId} expirat fără aprobare.`);
          rejectPost(postId);
        }
      }, 2 * 60 * 60 * 1000);

    } else {
      // Auto-post mode — fără aprobare
      const postId = crypto.randomUUID().replace(/-/g, "").substring(0, 16);
      postQueue.set(postId, { ...content, imagePath, timestamp: Date.now() });
      await publishPost(postId);
      console.log(`[marketing] Postat automat (fără TELEGRAM_ADMIN_CHAT_ID).`);
    }

  } catch (e) {
    console.error(`[marketing] Eroare: ${e.message}`);
  }
}

// Postează la 09:00, 13:00 și 18:00 (ora României — UTC+2)
cron.schedule("0 7 * * *", runMarketingPost, { timezone: "Europe/Bucharest" });   // 09:00 RO
cron.schedule("0 11 * * *", runMarketingPost, { timezone: "Europe/Bucharest" });  // 13:00 RO
cron.schedule("0 16 * * *", runMarketingPost, { timezone: "Europe/Bucharest" });  // 18:00 RO

console.log("📢 Marketing Bot pornit — postări la 09:00, 13:00, 18:00 (cu aprobare Telegram)");

module.exports = { approvePost, rejectPost, runMarketingPost };
