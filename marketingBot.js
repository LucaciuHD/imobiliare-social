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
const store = require("./dashboardStore");

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

async function generateMarketingContent(forcedCategoryName = null) {
  const category = forcedCategoryName
    ? CATEGORIES.find(c => c.name === forcedCategoryName) || CATEGORIES[_categoryIndex % CATEGORIES.length]
    : CATEGORIES[_categoryIndex % CATEGORIES.length];
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

  if (!response.ok) {
    const errText = await response.text();
    console.error("[marketing] Anthropic API error:", response.status, errText.slice(0, 200));
    throw new Error(`Anthropic API error ${response.status}`);
  }
  const data = await response.json();
  const text = data.content?.[0]?.text;
  if (!text) {
    console.error("[marketing] No content, data:", JSON.stringify(data).slice(0, 200));
    throw new Error("No content from Claude");
  }

  // Strip markdown code fences if present
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error("[marketing] Claude raw response:", text.slice(0, 300));
    throw new Error("Invalid JSON from Claude");
  }
  let content;
  try {
    content = JSON.parse(match[0]);
  } catch (e) {
    console.error("[marketing] JSON parse error:", e.message);
    console.error("[marketing] Matched string:", match[0].slice(0, 300));
    throw e;
  }

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
  const layout = _categoryIndex % 4;

  const composites = [];
  const svgParts = [];
  const logoBuffer = await getLogoBuffer();
  let bg;
  let logoSpec = { invert: false, x: PAD, y: H - 170, width: 230 };

  // Chevron decorativ ">" — SVG path
  function chev(x, y, size, color, opacity) {
    const half = size / 2, arm = size * 0.48;
    const sw = Math.round(size * 0.14);
    return `<path d="M ${x},${y} L ${x + arm},${y + half} L ${x},${y + size}" stroke="${color}" stroke-width="${sw}" fill="none" stroke-opacity="${opacity}" stroke-linejoin="round" stroke-linecap="round"/>`;
  }

  // Siluetă persoană flat cu braț care indică spre text
  // pointLeft=true → brațul se extinde spre stânga (spre text)
  function person(cx, bottomY, height, color, opacity, pointLeft = true) {
    const s = height / 520;
    const p = v => Math.round(v);
    const dir = pointLeft ? -1 : 1;

    // Y-uri calculate de jos în sus
    const legH = 175 * s, legW = 44 * s, legSpread = 38 * s;
    const hipH = 38 * s, hipHW = 58 * s;
    const torsoH = 150 * s, shldrHW = 68 * s, waistHW = 48 * s;
    const neckH = 24 * s, neckHW = 18 * s;
    const headR = 52 * s;
    const armThick = 20 * s;
    const armLen = 200 * s;

    const yLegBot = bottomY;
    const yHipBot = yLegBot - legH;
    const yHipTop = yHipBot - hipH;      // = yTorsoBot
    const yTorsoTop = yHipTop - torsoH;  // = yNeckBot
    const yNeckTop = yTorsoTop - neckH;
    const yCHead = yNeckTop - headR;

    // Braț care indică: pornește de la umărul "pointing side", se întinde oblic
    const armSx = cx - dir * shldrHW;
    const armSy = yTorsoTop + 30 * s;
    const armEx = armSx - dir * armLen;
    const armEy = armSy - 55 * s; // ușor în sus

    // Vector perpendicular pe braț (pentru grosime)
    const adx = armEx - armSx, ady = armEy - armSy;
    const alen = Math.sqrt(adx * adx + ady * ady);
    const nx = (-ady / alen) * (armThick / 2);
    const ny = (adx / alen) * (armThick / 2);

    // Braț la spate (atârnă lângă corp)
    const arm2Sx = cx + dir * shldrHW;
    const arm2Sy = yTorsoTop + 30 * s;
    const arm2Ex = arm2Sx + dir * 18 * s;
    const arm2Ey = yHipTop - 15 * s;
    const a2dx = arm2Ex - arm2Sx, a2dy = arm2Ey - arm2Sy;
    const a2len = Math.sqrt(a2dx * a2dx + a2dy * a2dy);
    const n2x = (-a2dy / a2len) * (armThick / 2);
    const n2y = (a2dx / a2len) * (armThick / 2);

    const parts = [
      // Cap
      `<circle cx="${p(cx)}" cy="${p(yCHead)}" r="${p(headR)}"/>`,
      // Gât
      `<rect x="${p(cx - neckHW)}" y="${p(yNeckTop)}" width="${p(neckHW * 2)}" height="${p(neckH)}"/>`,
      // Trunchi (trapez)
      `<path d="M ${p(cx-shldrHW)},${p(yTorsoTop)} L ${p(cx-waistHW)},${p(yHipTop)} L ${p(cx+waistHW)},${p(yHipTop)} L ${p(cx+shldrHW)},${p(yTorsoTop)} Z"/>`,
      // Braț care indică (trapez alungit)
      `<polygon points="${p(armSx+nx)},${p(armSy+ny)} ${p(armSx-nx)},${p(armSy-ny)} ${p(armEx-nx*0.35)},${p(armEy-ny*0.35)} ${p(armEx+nx*0.35)},${p(armEy+ny*0.35)}"/>`,
      // Mână (cerc mic la capătul brațului)
      `<circle cx="${p(armEx)}" cy="${p(armEy)}" r="${p(armThick * 0.7)}"/>`,
      // Braț relaxat
      `<polygon points="${p(arm2Sx+n2x)},${p(arm2Sy+n2y)} ${p(arm2Sx-n2x)},${p(arm2Sy-n2y)} ${p(arm2Ex-n2x*0.5)},${p(arm2Ey-n2y*0.5)} ${p(arm2Ex+n2x*0.5)},${p(arm2Ey+n2y*0.5)}"/>`,
      // Șolduri
      `<path d="M ${p(cx-waistHW)},${p(yHipTop)} L ${p(cx-hipHW)},${p(yHipBot)} L ${p(cx+hipHW)},${p(yHipBot)} L ${p(cx+waistHW)},${p(yHipTop)} Z"/>`,
      // Picior stâng
      `<path d="M ${p(cx-legSpread*0.2)},${p(yHipBot)} L ${p(cx-legSpread-legW)},${p(yLegBot)} L ${p(cx-legSpread+legW*0.6)},${p(yLegBot)} L ${p(cx+legSpread*0.3)},${p(yHipBot)} Z"/>`,
      // Picior drept
      `<path d="M ${p(cx-legSpread*0.3)},${p(yHipBot)} L ${p(cx+legSpread-legW*0.6)},${p(yLegBot)} L ${p(cx+legSpread+legW)},${p(yLegBot)} L ${p(cx+legSpread*0.2)},${p(yHipBot)} Z"/>`,
    ];

    return `<g fill="${color}" opacity="${opacity}">${parts.join("")}</g>`;
  }

  // Pill (dreptunghi rotunjit) cu text centrat
  function pill(text, cx, cy, fs, bgColor, textColor) {
    const tw = measureTextWidth(text, fs);
    const pw = tw + 64, ph = fs + 38;
    const px = Math.round(cx - pw / 2), py = Math.round(cy - ph / 2);
    return [
      `<rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="${Math.round(ph / 2)}" fill="${bgColor}"/>`,
      makeTextPath(text, cx, py + Math.round(ph * 0.67), fs, textColor),
    ].join("");
  }

  // ─────────────────────────────────────────────────────────────
  // LAYOUT 0 — "Brand Yellow": fundal galben, chevron alb stânga,
  // text negru mixed-case, arrows >>>>> centru, pill alb, logo jos-centru
  // ─────────────────────────────────────────────────────────────
  if (layout === 0) {
    bg = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 255, g: 215, b: 0, alpha: 1 } } }).png().toBuffer();

    svgParts.push(chev(-110, 80, 940, "white", 0.30));
    svgParts.push(chev(-200, 80, 940, "white", 0.13));

    // Siluetă agent imobiliar dreapta, braț indică stânga spre text
    svgParts.push(person(W - 160, H - PAD + 20, 520, "#111111", 0.14, true));

    const tx0 = 170, mw0 = W - tx0 - 260;
    const ls0 = Math.max(160, Math.round(H * 0.45 / Math.max(headline.length, 1)));
    const ty0 = Math.round(H * 0.28);
    headline.forEach((line, i) => {
      const fs = fitFontSize(line, mw0, 138, 48);
      svgParts.push(makeTextPathLeft(line, tx0, ty0 + i * ls0, fs, "#111111"));
    });

    svgParts.push(makeTextPath(">>>>>>", W / 2 + 50, Math.round(H * 0.62), 82, "#111111"));
    svgParts.push(pill("#alegesimplu", W / 2, Math.round(H * 0.74), 34, "white", "#111111"));
    // URL jos, nu suprapune textul
    const uW = measureTextWidth("simpluimobiliare.com", 24);
    svgParts.push(makeTextPathLeft("simpluimobiliare.com", W - PAD - uW, H - PAD - 22, 24, "#555555"));

    logoSpec = { invert: false, x: Math.round(W / 2 - 115), y: H - PAD - 108, width: 230 };
  }

  // ─────────────────────────────────────────────────────────────
  // LAYOUT 1 — "Bold Center": fundal galben, text ALL CAPS uriaș centrat,
  // pill alb jos, logo sus-stânga
  // ─────────────────────────────────────────────────────────────
  else if (layout === 1) {
    bg = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 255, g: 215, b: 0, alpha: 1 } } }).png().toBuffer();

    svgParts.push(chev(W - 170, 60, 960, "white", 0.24));

    // Siluetă agent imobiliar stânga, braț indică dreapta spre text
    svgParts.push(person(160, H - PAD + 20, 480, "#111111", 0.14, false));

    const ls1 = 185;
    const totalH1 = (headline.length - 1) * ls1;
    const ty1 = Math.round(H / 2 - totalH1 / 2);
    headline.forEach((line, i) => {
      const fs = fitFontSize(line.toUpperCase(), W - PAD * 2, 168, 64);
      svgParts.push(makeTextPath(line.toUpperCase(), W / 2, ty1 + i * ls1, fs, "#111111"));
    });

    svgParts.push(pill("#alegesimplu", W / 2, H - 190, 32, "white", "#111111"));
    svgParts.push(makeTextPath("0775 129 022", W / 2, H - PAD - 18, 28, "#444444"));

    logoSpec = { invert: false, x: PAD, y: PAD + 8, width: 190 };
  }

  // ─────────────────────────────────────────────────────────────
  // LAYOUT 2 — "Two Tone": galben sus 55%, alb jos 45%,
  // text pe galben, telefon + pill pe alb, logo jos-stânga
  // ─────────────────────────────────────────────────────────────
  else if (layout === 2) {
    bg = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();

    const splitY = Math.round(H * 0.56);
    svgParts.push(`<rect x="0" y="0" width="${W}" height="${splitY}" fill="#FFD700"/>`);
    svgParts.push(chev(-90, 30, splitY + 80, "white", 0.28));

    // Siluetă agent imobiliar dreapta, în zona galbenă — ușor cropped jos la splitY
    svgParts.push(`<clipPath id="yellowZone"><rect x="0" y="0" width="${W}" height="${splitY}"/></clipPath>`);
    svgParts.push(`<g clip-path="url(#yellowZone)">${person(W - 140, splitY + 40, 560, "#111111", 0.14, true)}</g>`);

    const tx2 = 160, mw2 = W - tx2 - 260;
    const ls2 = Math.max(150, Math.round((splitY * 0.66) / Math.max(headline.length, 1)));
    const ty2 = Math.round(splitY * 0.24);
    headline.forEach((line, i) => {
      const fs = fitFontSize(line, mw2, 130, 46);
      svgParts.push(makeTextPathLeft(line, tx2, ty2 + i * ls2, fs, "#111111"));
    });

    // URL jos în zona galbenă — nu mai suprapune textul
    const uW2 = measureTextWidth("simpluimobiliare.com", 22);
    svgParts.push(makeTextPathLeft("simpluimobiliare.com", W - PAD - uW2, splitY - 22, 22, "#555555"));

    svgParts.push(`<rect x="${PAD}" y="${splitY}" width="${W - PAD * 2}" height="2" fill="#ddd"/>`);
    svgParts.push(makeTextPath("0775 129 022", W / 2, splitY + 105, 42, "#111111"));
    svgParts.push(pill("#alegesimplu", W / 2, splitY + 210, 32, "#FFD700", "#111111"));

    logoSpec = { invert: false, x: PAD, y: splitY + 275, width: 200 };
  }

  // ─────────────────────────────────────────────────────────────
  // LAYOUT 3 — "Dark Impact": fundal negru, triunghi galben sus-stânga,
  // text alb ALL CAPS, linie galbenă, logo inversat sus-dreapta
  // ─────────────────────────────────────────────────────────────
  else {
    bg = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 14, g: 14, b: 14, alpha: 1 } } }).png().toBuffer();

    svgParts.push(`<polygon points="0,0 580,0 0,500" fill="#FFD700"/>`);
    svgParts.push(chev(W - 140, 180, 700, "white", 0.07));

    // Siluetă agent imobiliar jos-dreapta galben, braț indică stânga spre text
    svgParts.push(person(W - 150, H - PAD + 20, 500, "#FFD700", 0.22, true));

    const ls3 = 190;
    const totalH3 = (headline.length - 1) * ls3;
    const ty3 = Math.round(H * 0.52 - totalH3 / 2);
    headline.forEach((line, i) => {
      const fs = fitFontSize(line.toUpperCase(), W - PAD * 2, 168, 62);
      svgParts.push(makeTextPathLeft(line.toUpperCase(), PAD, ty3 + i * ls3, fs, "#FFFFFF"));
    });

    svgParts.push(`<rect x="${PAD}" y="${ty3 + headline.length * ls3 + 16}" width="180" height="7" fill="#FFD700"/>`);
    svgParts.push(makeTextPathLeft("simpluimobiliare.com", PAD, H - PAD - 18, 26, "rgba(255,255,255,0.38)"));

    logoSpec = { invert: true, x: W - PAD - 220, y: PAD + 8, width: 210 };
  }

  // SVG overlay
  composites.push({ input: Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` + svgParts.join("") + `</svg>`
  )});

  // Logo — ultimul strat, deasupra tuturor elementelor
  if (logoBuffer) {
    try {
      let p = sharp(logoBuffer).resize({ width: logoSpec.width, fit: "inside" });
      if (logoSpec.invert) p = p.negate({ alpha: false });
      const r = await p.png().toBuffer({ resolveWithObject: true });
      composites.push({ input: r.data, top: logoSpec.y, left: logoSpec.x });
    } catch (e) { console.warn("[logo]", e.message); }
  }

  const outputPath = path.join(OVERLAY_DIR, `marketing_${Date.now()}.jpg`);
  await sharp(bg).composite(composites).jpeg({ quality: 92 }).toFile(outputPath);
  return outputPath;
}

async function uploadPhotoToFacebook(imagePath, caption) {
  // Pas 1: upload foto ca unpublished → obținem photo_id
  const form = new FormData();
  form.append("source", fs.createReadStream(imagePath), { filename: "marketing.jpg", contentType: "image/jpeg" });
  form.append("published", "false");
  form.append("temporary", "true");
  form.append("access_token", FB_PAGE_TOKEN);
  const uploadRes = await fetch(`https://graph.facebook.com/v18.0/${FB_PAGE_ID}/photos`, {
    method: "POST", body: form, headers: form.getHeaders(),
  });
  const uploadData = await uploadRes.json();
  if (uploadData.error) throw new Error("FB photo upload: " + uploadData.error.message);
  const photoId = uploadData.id;

  // Pas 2: creare post în feed cu poza atașată — apare public în timeline
  const feedRes = await fetch(`https://graph.facebook.com/v18.0/${FB_PAGE_ID}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: caption,
      attached_media: [{ media_fbid: photoId }],
      published: true,
      access_token: FB_PAGE_TOKEN,
    }),
  });
  const feedData = await feedRes.json();
  if (feedData.error) throw new Error("FB feed post: " + feedData.error.message);
  return feedData.id;
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
    store.updateBot('marketing', { approved: store.botActivity.marketing.approved + 1 });
    return { ok: true, text: "✅ Postarea a fost publicată pe Facebook și Instagram!" };
  } catch (e) {
    return { ok: false, text: "❌ Eroare la publicare: " + e.message };
  }
}

// Called by bot.js when admin rejects — regenerează automat alta
// Șterge postarea fără regenerare (folosit la expirare automată)
function expirePost(postId) {
  const post = postQueue.get(postId);
  if (!post) return;
  setTimeout(() => { try { fs.unlinkSync(post.imagePath); } catch {} }, 1000);
  postQueue.delete(postId);
  store.updateBot('marketing', { expired: store.botActivity.marketing.expired + 1 });
  console.log(`[marketing] Post ${postId} expirat și șters.`);
  if (ADMIN_CHAT_ID && BOT_TOKEN) {
    sendTelegram(ADMIN_CHAT_ID, "⏰ Postarea de marketing a expirat (2 ore fără aprobare) și a fost ștearsă.").catch(() => {});
  }
}

// Respinge și regenerează cu aceeași categorie a slotului
async function rejectPost(postId) {
  const post = postQueue.get(postId);
  const forcedCategory = post?.forcedCategory || null;
  if (post) {
    setTimeout(() => { try { fs.unlinkSync(post.imagePath); } catch {} }, 1000);
    postQueue.delete(postId);
    store.updateBot('marketing', { rejected: store.botActivity.marketing.rejected + 1 });
  }
  try {
    console.log("[marketing] Postare respinsă — generez alta...");
    const content = await generateMarketingContent(forcedCategory);
    const imagePath = await generateMarketingImage(content.headline, content.category);
    const newId = crypto.randomUUID().replace(/-/g, "").substring(0, 16);
    postQueue.set(newId, { ...content, imagePath, timestamp: Date.now(), forcedCategory });
    const tgRes = await sendTelegramPreview(imagePath, content, newId);
    if (tgRes.ok) {
      console.log(`[marketing] Nouă postare trimisă pentru aprobare. ID: ${newId}`);
    }
    // Expiră după 2h — doar șterge, nu mai regenerează
    setTimeout(() => { if (postQueue.has(newId)) expirePost(newId); }, 2 * 60 * 60 * 1000);
  } catch (e) {
    console.error("[marketing] Eroare la regenerare:", e.message);
  }
}

async function runMarketingPost(forcedCategory = null) {
  store.updateBot('marketing', { lastRun: new Date().toISOString(), lastStatus: 'running' });
  try {
    const catName = forcedCategory || CATEGORIES[_categoryIndex % CATEGORIES.length].name;
    console.log(`[marketing] Generez postare... (${catName})`);

    const content = await generateMarketingContent(forcedCategory);
    const imagePath = await generateMarketingImage(content.headline, content.category);
    console.log(`[marketing] Conținut și imagine generate.`);

    store.updateBot('marketing', {
      lastStatus: 'ok',
      generated: store.botActivity.marketing.generated + 1,
    });

    if (ADMIN_CHAT_ID && BOT_TOKEN) {
      // Preview mode — trimite la admin pentru aprobare
      const postId = crypto.randomUUID().replace(/-/g, "").substring(0, 16);
      postQueue.set(postId, { ...content, imagePath, timestamp: Date.now(), forcedCategory });

      const tgRes = await sendTelegramPreview(imagePath, content, postId);
      if (tgRes.ok) {
        console.log(`[marketing] Preview trimis pe Telegram. ID: ${postId}`);
      } else {
        console.error("[marketing] Telegram preview failed:", JSON.stringify(tgRes));
        // Fallback: publică automat dacă Telegram nu merge
        await publishPost(postId);
      }

      // Auto-expire după 2 ore — șterge, nu regenerează
      setTimeout(() => { if (postQueue.has(postId)) expirePost(postId); }, 2 * 60 * 60 * 1000);

    } else {
      // Auto-post mode — fără aprobare
      const postId = crypto.randomUUID().replace(/-/g, "").substring(0, 16);
      postQueue.set(postId, { ...content, imagePath, timestamp: Date.now() });
      await publishPost(postId);
      console.log(`[marketing] Postat automat (fără TELEGRAM_ADMIN_CHAT_ID).`);
    }

  } catch (e) {
    console.error(`[marketing] Eroare: ${e.message}`, e.stack);
    store.updateBot('marketing', { lastStatus: 'error', lastError: e.message });
    if (ADMIN_CHAT_ID && BOT_TOKEN) {
      await sendTelegram(ADMIN_CHAT_ID, `❌ Eroare generare postare marketing:\n${e.message}`).catch(() => {});
    }
  }
}

// Postări zilnice cu categorii fixe (ora României)
cron.schedule("0 10 * * *", () => runMarketingPost("brand_bold"),       { timezone: "Europe/Bucharest" }); // 10:00 — reclamă firmă
cron.schedule("0 14 * * *", () => runMarketingPost("cumparator_witty"), { timezone: "Europe/Bucharest" }); // 14:00 — cumpărători
cron.schedule("0 18 * * *", () => runMarketingPost("vanzator_witty"),   { timezone: "Europe/Bucharest" }); // 18:00 — vânzători

console.log("📢 Marketing Bot pornit — postări la 10:00 (brand), 14:00 (cumpărători), 18:00 (vânzători)");

module.exports = { approvePost, rejectPost, expirePost, runMarketingPost };
