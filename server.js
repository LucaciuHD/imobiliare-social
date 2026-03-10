const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

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

const PROMPTS = {
  facebook: (info) => `Ești agent imobiliar profesionist la SIMPLU Imobiliare Craiova. Scrie o postare Facebook profesională, caldă și convingătoare. Include emoji-uri relevante și detaliile cheie. Termină postarea cu exact: "Totul este mai SIMPLU cu noi! 😊". NU include număr de telefon, date de contact sau cuvântul "showroom". Scrie toate cuvintele complet, fără abrevieri sau prescurtări. Max 400 cuvinte.\n\nProprietate:\n${info}`,
  instagram: (info) => `Ești agent imobiliar profesionist la SIMPLU Imobiliare Craiova. Scrie o postare Instagram captivantă cu emoji-uri și minim 15 hashtag-uri română+engleză. Termină textul (înainte de hashtag-uri) cu exact: "Totul este mai SIMPLU cu noi! 😊". NU include număr de telefon, date de contact sau cuvântul "showroom". Scrie toate cuvintele complet, fără abrevieri sau prescurtări. Max 300 cuvinte.\n\nProprietate:\n${info}`,
  tiktok: (info) => `Ești agent imobiliar profesionist la SIMPLU Imobiliare Craiova. Scrie un script TikTok scurt și energic cu hook puternic. Termină cu exact: "Totul este mai SIMPLU cu noi! 😊". NU include număr de telefon, date de contact sau cuvântul "showroom". Scrie toate cuvintele complet, fără abrevieri sau prescurtări. Max 200 cuvinte + hashtag-uri.\n\nProprietate:\n${info}`,
  whatsapp: (info) => `Ești agent imobiliar profesionist la SIMPLU Imobiliare Craiova. Scrie un mesaj WhatsApp concis și profesional. Termină cu exact: "Totul este mai SIMPLU cu noi! 😊". NU include număr de telefon, date de contact sau cuvântul "showroom". Scrie toate cuvintele complet, fără abrevieri sau prescurtări. Max 200 cuvinte.\n\nProprietate:\n${info}`,
};

// GET properties from CRM
app.get("/api/properties", async (req, res) => {
  try {
    const page = req.query.page || 1;
    const search = req.query.search || "";
    let url = `${CRM_BASE}/properties/?ordering=-created_at&limit=20&page=${page}&availability=1&token=${CRM_TOKEN}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
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
