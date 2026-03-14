require("dotenv").config();
const fetch = require("node-fetch");
const cron = require("node-cron");

const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const FB_PAGE_ID = process.env.FB_PAGE_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

const CONTACT_FOOTER = "\n\n📞 0775 129 022\n🏢 SIMPLU Imobiliare Craiova\n📍 Str. Dimitrie Bolintineanu Nr.14\n🌐 SIMPLUIMOBILIARE.COM";

// Categorii rotative — fiecare postare e din o categorie diferită
const CATEGORIES = [
  {
    name: "sfat_cumparator",
    prompt: `Ești expert imobiliar la SIMPLU Imobiliare Craiova. Scrie o postare Facebook utilă pentru persoanele care vor să CUMPERE o proprietate în Craiova.
Începe cu un emoji relevant și un sfat practic concret (ex: ce să verifici, cum să negociezi, ce acte să ceri, cum să evaluezi un apartament etc.).
NU folosi salutări gen "Bună ziua", "Dragi prieteni".
Termină OBLIGATORIU cu: "Totul este mai SIMPLU cu noi! 😊"
NU include număr de telefon sau adresă.
Max 250 cuvinte, cu emoji-uri. Sfatul să fie diferit de fiecare dată.`
  },
  {
    name: "sfat_vanzator",
    prompt: `Ești expert imobiliar la SIMPLU Imobiliare Craiova. Scrie o postare Facebook utilă pentru persoanele care vor să VÂNDĂ o proprietate în Craiova.
Începe cu un emoji relevant și un sfat practic concret (ex: cum să pregătești casa pentru vânzare, cum să stabilești prețul corect, ce acte să ai pregătite, cum să faci poze bune etc.).
NU folosi salutări gen "Bună ziua", "Dragi prieteni".
Termină OBLIGATORIU cu: "Totul este mai SIMPLU cu noi! 😊"
NU include număr de telefon sau adresă.
Max 250 cuvinte, cu emoji-uri. Sfatul să fie diferit de fiecare dată.`
  },
  {
    name: "brand_simplu",
    prompt: `Ești copywriter pentru SIMPLU Imobiliare Craiova. Scrie o postare Facebook de brand care evidențiază de ce SIMPLU Imobiliare este alegerea corectă în Craiova.
Poate fi despre: experiența echipei, portofoliul de proprietăți, profesionalism, rapiditate, transparență, sau o poveste de succes generică.
NU folosi salutări gen "Bună ziua", "Dragi prieteni".
Termină OBLIGATORIU cu: "Totul este mai SIMPLU cu noi! 😊"
NU include număr de telefon sau adresă.
Max 200 cuvinte, cu emoji-uri. Conținutul să fie variat de fiecare dată.`
  },
  {
    name: "piata_imobiliara",
    prompt: `Ești analist imobiliar la SIMPLU Imobiliare Craiova. Scrie o postare Facebook despre piața imobiliară din Craiova — tendințe, cerere/ofertă, zone populare, prețuri, oportunități de investiție.
NU folosi salutări gen "Bună ziua", "Dragi prieteni".
Termină OBLIGATORIU cu: "Totul este mai SIMPLU cu noi! 😊"
NU include număr de telefon sau adresă.
Max 250 cuvinte, cu emoji-uri. Informația să fie relevantă și actuală.`
  },
];

let _categoryIndex = 0;

async function generateMarketingPost() {
  const category = CATEGORIES[_categoryIndex % CATEGORIES.length];
  _categoryIndex++;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": ANTHROPIC_KEY,
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{ role: "user", content: category.prompt }],
    }),
  });

  const data = await response.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error("No content from Claude");
  return text + CONTACT_FOOTER;
}

async function postToFacebook(message) {
  const response = await fetch(`https://graph.facebook.com/v18.0/${FB_PAGE_ID}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, access_token: FB_PAGE_TOKEN }),
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.id;
}

async function runMarketingPost() {
  try {
    console.log(`[marketing] Generez postare... (categorie: ${CATEGORIES[_categoryIndex % CATEGORIES.length].name})`);
    const message = await generateMarketingPost();
    const postId = await postToFacebook(message);
    console.log(`[marketing] Postat cu succes! ID: ${postId}`);
  } catch (e) {
    console.error(`[marketing] Eroare: ${e.message}`);
  }
}

// Postează la 09:00, 13:00 și 18:00 (ora României — UTC+2)
cron.schedule("0 7 * * *", runMarketingPost, { timezone: "Europe/Bucharest" });   // 09:00 RO
cron.schedule("0 11 * * *", runMarketingPost, { timezone: "Europe/Bucharest" });  // 13:00 RO
cron.schedule("0 16 * * *", runMarketingPost, { timezone: "Europe/Bucharest" });  // 18:00 RO

console.log("📢 Marketing Bot pornit — postări la 09:00, 13:00, 18:00");
