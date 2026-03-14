require("dotenv").config();
const fetch = require("node-fetch");
const cron = require("node-cron");
const sharp = require("sharp");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const os = require("os");
const opentype = require("opentype.js");

const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const FB_PAGE_ID = process.env.FB_PAGE_ID;
const IG_ACCOUNT_ID = process.env.IG_ACCOUNT_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
// Railway sets RAILWAY_PUBLIC_DOMAIN automatically (e.g. "myapp.up.railway.app")
const PUBLIC_URL = process.env.PUBLIC_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN : null);

const OVERLAY_DIR = process.platform === "win32"
  ? path.join(os.tmpdir(), "overlays")
  : "/tmp/overlays";
fs.mkdirSync(OVERLAY_DIR, { recursive: true });

const LOGO_URL = "https://media.crmrebs.com/agencies/simpluimobiliare/logo/df1af06e-4181-4a4f-bded-cae60a80194c/Logo_Simplu_Imobiliare-01.png";
let _logoBuffer = null;
let _font = null;
try {
  _font = opentype.loadSync(path.join(__dirname, "fonts", "NotoSans-Bold.ttf"));
  console.log("[marketing-font] Loaded OK");
} catch (e) {
  console.error("[marketing-font] Failed:", e.message);
}

const CONTACT_FOOTER = "\n\n📞 0775 129 022\n🏢 SIMPLU Imobiliare Craiova\n📍 Str. Dimitrie Bolintineanu Nr.14\n🌐 SIMPLUIMOBILIARE.COM";

const CATEGORIES = [
  { name: "sfat_cumparator", topic: "sfaturi practice pentru CUMPĂRĂTORI de imobile în Craiova" },
  { name: "sfat_vanzator",   topic: "sfaturi practice pentru VÂNZĂTORI de imobile în Craiova" },
  { name: "brand_simplu",    topic: "de ce SIMPLU Imobiliare este alegerea corectă în Craiova — brand, echipă, profesionalism" },
  { name: "piata_imobiliara",topic: "piața imobiliară din Craiova — tendințe, prețuri, zone populare, oportunități" },
];

let _categoryIndex = 0;

async function generateMarketingContent() {
  const category = CATEGORIES[_categoryIndex % CATEGORIES.length];
  _categoryIndex++;

  const prompt = `Ești expert imobiliar la SIMPLU Imobiliare Craiova. Creează conținut de social media despre: ${category.topic}.

Răspunde STRICT cu un JSON valid în formatul următor (fără text în afara JSON-ului):
{
  "headline": ["linie1", "linie2", "linie3"],
  "facebook": "text complet postare Facebook",
  "instagram": "text complet postare Instagram"
}

REGULI headline (OBLIGATORIU):
- Exact 3 linii scurte (3-6 cuvinte fiecare)
- Prima linie cu emoji relevant
- Impactante, în română
- Fără punct la final de linie
- Exemplu: ["🏠 VREI SĂ CUMPERI?", "Iată ce TREBUIE să știi", "înainte de a semna!"]

REGULI facebook:
- Max 250 cuvinte, cu emoji-uri
- NU folosi salutări gen "Bună ziua", "Dragi prieteni"
- Termină OBLIGATORIU cu: "Totul este mai SIMPLU cu noi! 😊"
- 10 hashtag-uri relevante la final
- NU include număr de telefon sau adresă

REGULI instagram:
- Max 200 cuvinte, cu emoji-uri
- NU folosi salutări gen "Bună ziua", "Dragi prieteni"
- Termină OBLIGATORIU cu: "Totul este mai SIMPLU cu noi! 😊"
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
  if (!match) throw new Error("Invalid JSON from Claude: " + text.substring(0, 200));
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

async function generateMarketingImage(headline) {
  const W = 1080, H = 1080;
  const cx = W / 2;

  // Dark navy background
  const bg = await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 13, g: 27, b: 42, alpha: 1 } }
  }).png().toBuffer();

  const composites = [];

  // Logo centered in upper half
  const logoBuffer = await getLogoBuffer();
  if (logoBuffer) {
    const resized = await sharp(logoBuffer)
      .resize({ width: 420, fit: "inside" })
      .toBuffer({ resolveWithObject: true });
    composites.push({
      input: resized.data,
      top: 130,
      left: Math.round((W - resized.info.width) / 2),
    });
  }

  // Headline text — 3 lines in lower half
  const fontSize = 74;
  const lineSpacing = 108;
  const textStartY = 620;
  let textPaths = "";
  headline.forEach((line, i) => {
    textPaths += makeTextPath(line, cx, textStartY + i * lineSpacing, fontSize, "#FFFFFF");
  });

  // Tagline bottom
  const tagline = makeTextPath("SIMPLUIMOBILIARE.COM", cx, 1010, 34, "#FFD700");

  // SVG overlay: golden strips + semi-transparent bar + text
  const svgOverlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    `<rect x="0" y="0" width="${W}" height="16" fill="#FFD700"/>` +
    `<rect x="0" y="${H - 16}" width="${W}" height="16" fill="#FFD700"/>` +
    `<rect x="0" y="${H - 70}" width="${W}" height="54" fill="rgba(0,0,0,0.55)"/>` +
    textPaths +
    tagline +
    `</svg>`
  );

  composites.push({ input: svgOverlay });

  const outputPath = path.join(OVERLAY_DIR, `marketing_${Date.now()}.jpg`);
  await sharp(bg)
    .composite(composites)
    .jpeg({ quality: 92 })
    .toFile(outputPath);

  return outputPath;
}

async function uploadPhotoToFacebook(imagePath, caption) {
  const form = new FormData();
  form.append("source", fs.createReadStream(imagePath), { filename: "marketing.jpg", contentType: "image/jpeg" });
  form.append("caption", caption);
  form.append("published", "true");
  form.append("access_token", FB_PAGE_TOKEN);
  const r = await fetch(`https://graph.facebook.com/v18.0/${FB_PAGE_ID}/photos`, {
    method: "POST",
    body: form,
    headers: form.getHeaders(),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.id;
}

async function postToInstagram(imagePublicUrl, caption) {
  const containerRes = await fetch(`https://graph.facebook.com/v18.0/${IG_ACCOUNT_ID}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_url: imagePublicUrl, caption, access_token: FB_PAGE_TOKEN }),
  });
  const container = await containerRes.json();
  if (container.error) throw new Error("IG container: " + container.error.message);

  const publishRes = await fetch(`https://graph.facebook.com/v18.0/${IG_ACCOUNT_ID}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: container.id, access_token: FB_PAGE_TOKEN }),
  });
  const published = await publishRes.json();
  if (published.error) throw new Error("IG publish: " + published.error.message);
  return published.id;
}

async function runMarketingPost() {
  try {
    const catName = CATEGORIES[_categoryIndex % CATEGORIES.length].name;
    console.log(`[marketing] Generez postare... (${catName})`);

    const content = await generateMarketingContent();
    console.log(`[marketing] Conținut generat. Headline: ${content.headline.join(" | ")}`);

    const imagePath = await generateMarketingImage(content.headline);
    console.log(`[marketing] Imagine generată.`);

    // Facebook
    const fbId = await uploadPhotoToFacebook(imagePath, content.facebook);
    console.log(`[marketing] Facebook OK! ID: ${fbId}`);

    // Instagram
    if (PUBLIC_URL && IG_ACCOUNT_ID) {
      const filename = path.basename(imagePath);
      const igId = await postToInstagram(`${PUBLIC_URL}/overlays/${filename}`, content.instagram);
      console.log(`[marketing] Instagram OK! ID: ${igId}`);
    } else {
      console.log("[marketing] Instagram skipped — PUBLIC_URL sau IG_ACCOUNT_ID lipsesc");
    }

    // Cleanup după 30 min
    setTimeout(() => { try { fs.unlinkSync(imagePath); } catch {} }, 30 * 60 * 1000);

  } catch (e) {
    console.error(`[marketing] Eroare: ${e.message}`);
  }
}

// Postează la 09:00, 13:00 și 18:00 (ora României — UTC+2)
cron.schedule("0 7 * * *", runMarketingPost, { timezone: "Europe/Bucharest" });   // 09:00 RO
cron.schedule("0 11 * * *", runMarketingPost, { timezone: "Europe/Bucharest" });  // 13:00 RO
cron.schedule("0 16 * * *", runMarketingPost, { timezone: "Europe/Bucharest" });  // 18:00 RO

console.log("📢 Marketing Bot pornit — postări la 09:00, 13:00, 18:00 (FB + IG cu imagine)");
