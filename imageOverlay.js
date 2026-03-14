const fetch = require("node-fetch");
const sharp = require("sharp");
const path = require("path");
const opentype = require("opentype.js");

const LOGO_URL = "https://media.crmrebs.com/agencies/simpluimobiliare/logo/df1af06e-4181-4a4f-bded-cae60a80194c/Logo_Simplu_Imobiliare-01.png";
let _logoBuffer = null;

// Load font once at startup — opentype.js reads TTF directly, no system font needed
let _font = null;
try {
  _font = opentype.loadSync(path.join(__dirname, "fonts", "NotoSans-Bold.ttf"));
  console.log("[font] Loaded OK");
} catch (e) {
  console.error("[font] Failed to load font:", e.message);
}

function escapeXml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function createLabelSvg(text, pw, ph, fontSize, rx) {
  // Rounded rect path (SVG native)
  const rectPath = `M${rx},0 L${pw - rx},0 Q${pw},0 ${pw},${rx} L${pw},${ph - rx} Q${pw},${ph} ${pw - rx},${ph} L${rx},${ph} Q0,${ph} 0,${ph - rx} L0,${rx} Q0,0 ${rx},0 Z`;

  if (!_font) {
    // Fallback: SVG text (may show squares on some systems, but better than nothing)
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}">` +
      `<path d="${rectPath}" fill="#FFD700"/>` +
      `<text x="${pw / 2}" y="${ph / 2 + fontSize * 0.35}" text-anchor="middle" font-size="${fontSize}" font-weight="bold" fill="#111111">${escapeXml(text)}</text>` +
      `</svg>`
    );
  }

  // Convert text to SVG paths via opentype.js — zero system font dependency
  const pathAtOrigin = _font.getPath(text, 0, 0, fontSize);
  const bb = pathAtOrigin.getBoundingBox();
  const textW = bb.x2 - bb.x1;
  const cx = pw / 2 - bb.x1 - textW / 2;
  const cy = ph / 2 - (bb.y1 + bb.y2) / 2;
  const finalPath = _font.getPath(text, cx, cy, fontSize);

  const d = finalPath.commands.map(cmd => {
    const f = v => v.toFixed(2);
    if (cmd.type === "M") return `M${f(cmd.x)},${f(cmd.y)}`;
    if (cmd.type === "L") return `L${f(cmd.x)},${f(cmd.y)}`;
    if (cmd.type === "C") return `C${f(cmd.x1)},${f(cmd.y1)},${f(cmd.x2)},${f(cmd.y2)},${f(cmd.x)},${f(cmd.y)}`;
    if (cmd.type === "Q") return `Q${f(cmd.x1)},${f(cmd.y1)},${f(cmd.x)},${f(cmd.y)}`;
    if (cmd.type === "Z") return "Z";
    return "";
  }).join("");

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}">` +
    `<path d="${rectPath}" fill="#FFD700"/>` +
    `<path d="${d}" fill="#111111"/>` +
    `</svg>`
  );
}

async function getLogoBuffer() {
  if (_logoBuffer) return _logoBuffer;
  try {
    const r = await fetch(LOGO_URL);
    if (r.ok) _logoBuffer = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    console.error("Logo fetch failed:", e.message);
  }
  return _logoBuffer;
}


async function applyOverlayToImage(imageUrl, text, outputPath) {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());

  const meta = await sharp(buffer).metadata();
  const w = meta.width || 800;
  const h = meta.height || 600;

  // Scale all dimensions proportionally to image size
  const scale = Math.max(1, w / 900);
  const fontSize = Math.round(26 * scale);
  const ph = Math.round(54 * scale);
  const rx = Math.round(27 * scale);
  const px = Math.round(18 * scale);
  const py = Math.round(18 * scale);
  const charPx = Math.round(15.5 * scale);
  const padding = Math.round(32 * scale);

  const len = text.length;
  const rawPw = len * charPx + padding;
  const pw = Math.min(rawPw, w - px * 2);

  // Render label as SVG with text converted to paths (platform-independent)
  const labelSvg = createLabelSvg(text, pw, ph, fontSize, rx);
  const labelPng = await sharp(labelSvg).png().toBuffer();
  const composites = [{ input: labelPng, top: py, left: px }];

  // Logo watermark — centered
  const logoBuffer = await getLogoBuffer();
  if (logoBuffer) {
    const logoW = Math.round(320 * scale);
    const resized = await sharp(logoBuffer)
      .resize({ width: logoW, fit: "inside" })
      .toBuffer({ resolveWithObject: true });
    composites.push({
      input: resized.data,
      top: Math.round((h - resized.info.height) / 2),
      left: Math.round((w - resized.info.width) / 2),
    });
  }

  await sharp(buffer)
    .composite(composites)
    .jpeg({ quality: 88 })
    .toFile(outputPath);

  return outputPath;
}

function formatSurface(p) {
  const useful = p.surface_useful ? Number(p.surface_useful) : null;
  const built = p.surface_built ? Number(p.surface_built) : null;
  if (useful && built && useful !== built) return `${useful} mp utili (${built} mp totali)`;
  if (useful) return `${useful} mp`;
  if (built) return `${built} mp`;
  return null;
}

function formatFloor(p) {
  if (p.floor == null) return null;
  const f = Number(p.floor);
  if (f === 0) return "parter";
  return `etaj ${f}`;
}

function buildPropertySummary(p) {
  const PROP_TYPES = { 1: "Apartament", 2: "Casă", 3: "Teren", 4: "Spațiu comercial", 5: "Birou", 6: "Depozit", 7: "Hotel" };
  const APT_TYPES = { 1: "Garsonieră", 2: "2 camere", 3: "3 camere", 4: "4+ camere" };
  const type = p.property_type === 1 && p.apartment_type
    ? APT_TYPES[p.apartment_type] || "Apartament"
    : PROP_TYPES[p.property_type] || "Proprietate";
  const surface = formatSurface(p);
  return [
    `Tip: ${type}`,
    `Preț: ${p.price_sale ? Number(p.price_sale).toLocaleString("ro-RO") + " EUR" : p.price_rent ? Number(p.price_rent).toLocaleString("ro-RO") + " EUR/lună" : "La cerere"}`,
    surface ? `Suprafață: ${surface}` : null,
    `Camere: ${p.rooms || "N/A"}`,
    `Etaj: ${formatFloor(p) || "N/A"}`,
    `An construcție: ${p.construction_year || "N/A"}`,
    `Descriere: ${p.description ? p.description.substring(0, 500) : "N/A"}`,
  ].filter(Boolean).join("\n");
}

function generateFallbackHighlights(property, count) {
  const highlights = [];
  const floorText = formatFloor(property);
  if (floorText) highlights.push(floorText);
  const surfaceText = formatSurface(property);
  if (surfaceText) highlights.push(surfaceText);
  if (property.rooms) highlights.push(`${property.rooms} camere`);
  if (property.construction_year) highlights.push(`construit ${property.construction_year}`);
  if (property.price_sale) highlights.push(`${Number(property.price_sale).toLocaleString("ro-RO")} EUR`);
  while (highlights.length < count) highlights.push("SIMPLU Imobiliare");
  return highlights.slice(0, count);
}

async function generateHighlights(property, count, anthropicKey) {
  const summary = buildPropertySummary(property);
  const floorText = formatFloor(property);
  const surfaceText = formatSurface(property);

  const mandatoryRules = [
    floorText ? `- OBLIGATORIU primul element să fie etajul, exact: "${floorText}"` : "",
    surfaceText ? `- OBLIGATORIU să conțină suprafața, exact: "${surfaceText}"` : "",
  ].filter(Boolean).join("\n");

  const prompt = `Ești agent imobiliar. Pe baza datelor proprietății de mai jos, generează exact ${count} texte scurte (2-6 cuvinte fiecare) pentru etichete pe fotografii. Fiecare text evidențiază un aspect distinct.

REGULI OBLIGATORII:
${mandatoryRules}
- Restul etichetelor: locație, caracteristici speciale din descriere, an construcție, preț etc.
- Răspunde DOAR cu un JSON array valid, fără alte explicații.

Exemplu: ["etaj 3 din 4","65 mp utili (80 mp totali)","ultracentral","are gaze la usa","bloc reabilitat 2019"]

Proprietate:
${summary}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": anthropicKey,
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        stream: false,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || "";
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        while (parsed.length < count) parsed.push(parsed[parsed.length - 1] || "SIMPLU Imobiliare");
        return parsed.slice(0, count);
      }
    }
  } catch (e) {
    console.error("Highlights generation error:", e.message);
  }

  return generateFallbackHighlights(property, count);
}

module.exports = { generateHighlights, applyOverlayToImage };
