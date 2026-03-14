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
try {
  _font = opentype.loadSync(path.join(__dirname, "fonts", "NotoSans-Bold.ttf"));
  console.log("[marketing-font] Loaded OK");
} catch (e) {
  console.error("[marketing-font] Failed:", e.message);
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

async function generateMarketingImage(headline) {
  const W = 1080, H = 1080;
  const cx = W / 2;

  // Alternăm între 2 layout-uri: galben-pe-negru și negru-pe-galben
  const useYellowBlock = (Date.now() % 2 === 0);

  // Fundal negru
  const bg = await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 17, g: 17, b: 17, alpha: 1 } }
  }).png().toBuffer();

  const composites = [];

  // --- Layout 1: bloc galben mare în centru, text negru pe el ---
  // --- Layout 2: text alb mare pe negru, accent galben ---
  const YELLOW_TOP = 340;
  const YELLOW_H = 380;
  const PAD = 60;
  const MAX_TEXT_W = W - PAD * 2;

  let svgParts = [];

  if (useYellowBlock) {
    // Bloc galben central
    svgParts.push(`<rect x="0" y="${YELLOW_TOP}" width="${W}" height="${YELLOW_H}" fill="#FFD700"/>`);
    // Linii decorative negre deasupra și dedesubt blocului
    svgParts.push(`<rect x="0" y="${YELLOW_TOP}" width="${W}" height="8" fill="#111"/>`);
    svgParts.push(`<rect x="0" y="${YELLOW_TOP + YELLOW_H - 8}" width="${W}" height="8" fill="#111"/>`);

    // Text negru pe galben
    const lineCount = headline.length;
    const totalTextH = lineCount <= 1 ? 0 : (lineCount - 1) * 130;
    const textStartY = YELLOW_TOP + YELLOW_H / 2 - totalTextH / 2 + 10;
    headline.forEach((line, i) => {
      const fontSize = fitFontSize(line, MAX_TEXT_W, 110, 48);
      svgParts.push(makeTextPath(line, cx, textStartY + i * 130, fontSize, "#111111"));
    });

    // Logo area: text simplu jos pe negru
    svgParts.push(`<rect x="0" y="${H - 90}" width="${W}" height="90" fill="#111"/>`);
    const taglineSize = fitFontSize("SIMPLU IMOBILIARE", MAX_TEXT_W, 38, 24);
    svgParts.push(makeTextPath("SIMPLU IMOBILIARE", cx, H - 38, taglineSize, "#FFD700"));

  } else {
    // Bara galbenă stânga (accent vertical)
    svgParts.push(`<rect x="0" y="0" width="18" height="${H}" fill="#FFD700"/>`);
    // Bara galbenă sus și jos
    svgParts.push(`<rect x="0" y="0" width="${W}" height="18" fill="#FFD700"/>`);
    svgParts.push(`<rect x="0" y="${H - 18}" width="${W}" height="18" fill="#FFD700"/>`);

    // Text alb mare pe negru
    const lineCount = headline.length;
    const totalTextH = lineCount <= 1 ? 0 : (lineCount - 1) * 140;
    const textStartY = H / 2 - totalTextH / 2 - 60;
    headline.forEach((line, i) => {
      const fontSize = fitFontSize(line, MAX_TEXT_W - 40, 120, 52);
      svgParts.push(makeTextPath(line, cx + 10, textStartY + i * 140, fontSize, "#FFFFFF"));
    });

    // Linie separator + tagline galben jos
    svgParts.push(`<rect x="${PAD}" y="${H - 120}" width="${W - PAD * 2}" height="3" fill="#FFD700"/>`);
    const taglineSize = fitFontSize("SIMPLUIMOBILIARE.COM", MAX_TEXT_W, 36, 22);
    svgParts.push(makeTextPath("SIMPLUIMOBILIARE.COM", cx + 10, H - 50, taglineSize, "#FFD700"));
  }

  const svgOverlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    svgParts.join("") +
    `</svg>`
  );
  composites.push({ input: svgOverlay });

  // Logo PNG deasupra (doar pe layout 2, pe negru sus)
  if (!useYellowBlock) {
    const logoBuffer = await getLogoBuffer();
    if (logoBuffer) {
      try {
        const resized = await sharp(logoBuffer)
          .resize({ width: 300, fit: "inside" })
          .png()
          .toBuffer({ resolveWithObject: true });
        composites.unshift({
          input: resized.data,
          top: 50,
          left: Math.round((W - resized.info.width) / 2),
        });
      } catch {}
    }
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
  const caption = [
    `📋 <b>PREVIZUALIZARE POSTARE</b>`,
    `📂 Categorie: ${post.category}`,
    `🏷 Headline: <i>${post.headline.join(" | ")}</i>`,
    ``,
    `<b>Facebook preview:</b>`,
    post.facebook.substring(0, 400) + (post.facebook.length > 400 ? "..." : ""),
  ].join("\n");

  const form = new FormData();
  form.append("chat_id", String(ADMIN_CHAT_ID));
  form.append("photo", fs.createReadStream(imagePath), { filename: "preview.jpg", contentType: "image/jpeg" });
  form.append("caption", caption.substring(0, 1024));
  form.append("parse_mode", "HTML");
  form.append("reply_markup", JSON.stringify({
    inline_keyboard: [[
      { text: "✅ Aprobă și publică", callback_data: `mkt_ok_${postId}` },
      { text: "❌ Respinge", callback_data: `mkt_no_${postId}` },
    ]]
  }));

  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: "POST", body: form, headers: form.getHeaders(),
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
    const imagePath = await generateMarketingImage(content.headline);
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
    const imagePath = await generateMarketingImage(content.headline);
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
