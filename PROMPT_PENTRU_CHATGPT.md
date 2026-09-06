# Prompt pentru ChatGPT (sau alt asistent cu acces la terminal/GitHub)

Copiază tot ce urmează și dă-l executorului care are acces la terminalul tău și la
conturile de GitHub/Netlify. Proiectul e deja scris și testat local — sarcina lui este
doar să-l publice, nu să rescrie codul.

---

Am un proiect Node.js/Express, deja complet (frontend + backend), aflat în folderul
`campanie-platforma`, pregătit special pentru deploy pe Netlify (folosește
`netlify/functions` + Netlify Blobs pentru date, nu are nevoie de o bază de date externă).

Te rog să faci următorii pași, în ordine, și să-mi confirmi rezultatul fiecăruia:

1. **Verifică structura proiectului** — confirmă că există `netlify.toml`,
   `netlify/functions/api.js`, `app.js`, `local-server.js`, `package.json`.

2. **Inițializează un repo git local** (dacă nu există deja) și fă primul commit:
   ```
   git init
   git add .
   git commit -m "Prima versiune - platforma pilot pentru candidati"
   git branch -M main
   ```

3. **Creează un repo nou pe GitHub** (privat, nu public — proiectul conține logica de
   autentificare a candidaților) și conectează-l:
   ```
   git remote add origin https://github.com/NUMELE_MEU_DE_UTILIZATOR/campanie-platforma.git
   git push -u origin main
   ```
   (Cere-mi numele de utilizator GitHub și numele exact al repo-ului dacă nu le ai.)

4. **Conectează repo-ul la Netlify**:
   - Intră pe app.netlify.com → "Add new site" → "Import an existing project" → GitHub
   - Selectează repo-ul `campanie-platforma`
   - Netlify va detecta automat `netlify.toml` — nu schimba setările de build implicite

5. **Configurează variabilele de mediu pe Netlify** (Site settings → Environment
   variables):
   - `SESSION_SECRET` — generează un text lung, aleatoriu (ex: 32+ caractere)
   - `ANTHROPIC_API_KEY` — mi-o vei cere separat, e cheia mea privată de API

6. **Declanșează deploy-ul** și dă-mi link-ul final al site-ului.

7. După primul deploy, **testează fluxul**:
   - Accesează `/login` cu `admin@platforma.ro` / `admin123`
   - Creează un candidat de test din `/admin`
   - Loghează-te cu acel candidat, publică un articol
   - Verifică pagina publică a candidatului (`/site/subdomeniul-lui`)
   - Reîmprospătează pagina — confirmă că articolul a rămas salvat (asta testează
     Netlify Blobs, funcționează diferit față de mediul local)

8. Dacă orice pas eșuează, oprește-te și arată-mi mesajul exact de eroare, nu încerca
   să rescrii cod fără să mă întrebi întâi.

**Nu modifica logica aplicației** (`app.js`, `db.js`, `store.js`) — doar execută pașii
de publicare. Dacă ceva pare "greșit" în cod, întreabă-mă înainte să schimbi ceva.
