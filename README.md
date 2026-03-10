# Simplu Imobiliare — Social Media Generator

## Deploy pe Railway

### Pasul 1 — Încarcă pe GitHub
1. Mergi la github.com → New Repository → numește-l `imobiliare-social`
2. Încarcă toate fișierele din acest folder

### Pasul 2 — Deploy pe Railway
1. Mergi la railway.app
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Selectează repo-ul `imobiliare-social`
4. Railway detectează automat Node.js și face deploy

### Pasul 3 — Adaugă variabilele de mediu
În Railway → proiectul tău → **Variables** → adaugă:
```
ANTHROPIC_KEY = cheia_ta_anthropic
CRM_TOKEN = 8b5b5946671da2a80fc41481760673ab2868ba99
```

### Pasul 4 — Accesează platforma
Railway îți dă un link de tipul: `https://imobiliare-social.railway.app`
Deschide-l și gata! 🚀
