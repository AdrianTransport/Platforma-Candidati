# Platforma de campanie — prototip pilot (10 candidați), pregătit pentru Netlify

Prototip funcțional: Super Admin creează conturi de candidat, fiecare candidat are un
dashboard unde publică idei/program/anunțuri (cu ajutor de la un asistent AI), iar fiecare
candidat are un site public în stil ziar local/tabloid modern.

Codul e structurat să ruleze **și local** (`npm start`), **și pe Netlify** (GitHub → deploy
automat), fără să fie nevoie de o bază de date externă separată.

## Structura tehnica (important de stiut)

- `app.js` — toată aplicația Express (rute, view-uri), exportată ca funcție `createApp()`,
  fără `.listen()`.
- `local-server.js` — punctul de pornire pentru rulare locală (`npm start`), apelează
  `createApp()` și pornește serverul pe un port normal.
- `netlify/functions/api.js` — punctul de pornire pentru Netlify: împachetează aceeași
  aplicație Express într-o funcție serverless (`serverless-http`).
- `store.js` — stratul de stocare a datelor: local scrie într-un fișier JSON
  (`data/db.json`), pe Netlify scrie automat în **Netlify Blobs** (stocare inclusă,
  fără cont sau serviciu extern de bază de date).
- `netlify.toml` — configurează Netlify să servească `public/` static și să trimită tot
  restul traficului către funcția `api`.

## Rulare locală

```bash
npm install
cp .env.example .env
npm start
```

Deschide `http://localhost:3000`. Cont admin implicit: `admin@platforma.ro` / `admin123`
(schimbă parola înainte de folosire reală).

## Deploy pe Netlify (prin GitHub)

1. Publici acest folder pe un repo GitHub (vezi `PROMPT_PENTRU_CHATGPT.md` pentru pașii
   exacți, dacă vrei să delegi asta către un executor precum ChatGPT/Claude Code).
2. Pe [app.netlify.com](https://app.netlify.com): „Add new site” → „Import an existing
   project” → alegi repo-ul de GitHub.
3. Netlify detectează automat `netlify.toml`. Nu trebuie schimbat nimic la setările de
   build.
4. La „Site settings → Environment variables”, adaugi:
   - `SESSION_SECRET` — un text lung, aleatoriu (necesar pentru sesiuni sigure)
   - `ANTHROPIC_API_KEY` — cheia ta de la https://console.anthropic.com/settings/keys
     (opțional — fără ea, doar butonul „Genereaza draft” nu va funcționa)
5. Apeși „Deploy site”. La fiecare `git push` ulterior, Netlify redeploy-ează automat.
6. **Netlify Blobs** e activat automat pentru orice site Netlify — nu trebuie creat sau
   configurat separat, funcționează din prima odată ce funcția rulează pe Netlify.

## Reparatie facuta dupa primul test pe Netlify

Prima versiune arunca eroarea `TypeError - The "path" argument must be of type string
or an instance of URL. Received undefined` la orice cerere pe Netlify. Cauza: codul
folosea `import.meta.url` ca sa gaseasca folderele `views`/`public`, iar acea valoare
devine `undefined` dupa ce Netlify impacheteaza functia cu esbuild. Am inlocuit-o cu
`process.cwd()` (functioneaza identic local si pe Netlify) si am adaugat
`included_files` in `netlify.toml`, ca folderele `views/` si `public/` sa ajunga
efectiv in pachetul functiei (altfel EJS-urile nu ar fi gasite la runtime, desi codul
JS ar porni fara eroare).

## Important: ce am testat eu, ce trebuie testat pe Netlify

Am testat local, integral, fluxul: login admin → creare candidat → login candidat →
publicare articol → afișare pe site public — funcționează corect cu noua arhitectură.

**Nu am putut testa integrarea reală cu Netlify Blobs** (mediul meu de lucru nu are acces
la serviciile Netlify) — codul e scris conform documentației oficiale `@netlify/blobs`, dar
primul test real pe Netlify (după primul deploy) merită verificat: creezi un candidat de
test, publici un articol, apoi reîmprospătezi pagina, ca să confirmi că datele au rămas
salvate.

## Ce NU este încă inclus (pași următori)

- Conectarea domeniilor proprii ale candidaților (`anamarinescu.ro` → subdomeniul
  platformei) — se face din Netlify, „Domain settings → Add custom domain”, per candidat.
- Postare automată pe Facebook/TikTok — necesită OAuth per candidat și, pentru TikTok,
  auditul lor de conformitate.
- Auto-înregistrare / plăți — conturile sunt create manual de admin, cum ați cerut pentru
  pilotul de 10 candidați.
- Verificare juridică (AEP, GDPR) — de confirmat cu un avocat înainte de lansarea reală.

## Structura proiectului

```
app.js                    - toata aplicatia Express (rute, logica)
local-server.js           - pornire locala
netlify/functions/api.js  - pornire pe Netlify (functie serverless)
store.js                  - stocare date: fisier JSON local / Netlify Blobs
db.js                     - initializare date + functii ajutatoare
netlify.toml              - configurare Netlify
middleware/auth.js        - protectia rutelor pe roluri (admin / candidat)
views/                    - paginile HTML (EJS)
public/style.css          - stilurile pentru admin, dashboard si site public
```
