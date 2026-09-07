# Platforma de campanie — prototip pilot (10 candidați), pregătit pentru Netlify

Prototip funcțional: Super Admin creează conturi de candidat, fiecare candidat are un
dashboard unde publică idei/program/anunțuri (cu ajutor de la un asistent AI), iar fiecare
candidat are un site public în stil ziar local/tabloid modern.

## Funcțiile lotului „platformă publică”

- `/` este pagina publică de prezentare a platformei; autentificarea este separată la
  `/login`.
- Super Admin gestionează starea conturilor (`în așteptare`, `activ`, `suspendat`,
  `expirat`), funcția pentru care candidează persoana, zona, județul, partidul și modulele
  disponibile.
- Candidatul își completează sloganul, prezentarea și legăturile către Facebook,
  Instagram, TikTok și YouTube.
- Site-ul candidatului este o publicație electorală responsive, cu articol principal,
  carduri clickabile, secțiuni pe categorii și pagini individuale pentru articole.
- Dashboardul afișează vizitele publicației, citirile articolelor, sursele generale ale
  traficului și clickurile către rețelele sociale. Nu sunt stocate IP-uri și nu sunt create
  profiluri politice ale vizitatorilor.
- Autentificarea se blochează temporar după 5 încercări greșite, iar Super Adminul își
  poate schimba parola din dashboard (minimum 12 caractere).

Lotul „Centru social” adaugă OAuth pentru Meta și TikTok, alegerea Paginii Facebook,
detectarea contului Instagram profesional asociat, publicare individuală pe rețea și
istoricul distribuirilor. Tokenurile sunt criptate înainte de salvarea în Netlify Blobs.
Funcțiile devin active după configurarea și aprobarea aplicațiilor Meta/TikTok.

Codul e structurat să ruleze **și local** (`npm start`), **și pe Netlify** (GitHub → deploy
automat), fără să fie nevoie de o bază de date externă separată.

## Lot nou: programare, contact, căutare și comentarii moderate

- Candidatul poate edita funcția candidaturii, localitatea/zona, județul și, opțional,
  emailul/telefonul public. `/site/:subdomeniu/contact` afișează doar aceste câmpuri;
  nu folosește emailul de autentificare. Golirea câmpurilor retrage contactul public.
- Articolele se salvează ca `ciorna`, `publicat` sau `programat`. Formularul folosește
  **Europe/Bucharest**, indiferent de fusul browserului/serverului; stocarea este UTC.
  Datele trecute, invalide și orele inexistente/ambigue la schimbarea orei sunt respinse.
- Vizibilitatea este evaluată la fiecare cerere, inclusiv pe URL-ul direct, în căutare,
  clasamente și centrul social. La termen, articolul devine accesibil fără cron și fără
  schimbarea înregistrării `programat`. O pagină deja deschisă trebuie reîmprospătată.
  **Nu se programează distribuirea socială și nu se activează Meta/TikTok.**
- Căutarea în titlu/conținut ignoră diacriticele și poate fi combinată cu o categorie.
  Ciornele și articolele viitoare nu apar nici în rezultate, nici în lista categoriilor.
- Comentariile sunt implicit `in_asteptare`. Numai Super Adminul poate aproba, respinge
  sau șterge logic din `/admin/comentarii`; listele administrative au 25 de intrări/pagină.
  Public sunt afișate numai comentariile aprobate ale articolului respectiv.
- Ștergerea logică este terminală și păstrează textul plus istoricul moderării pentru
  administrator. Nu este ștergere definitivă a datelor. Istoricul conține ID-ul
  administratorului, acțiunea, data și versiunea anterioară.
- Formularele pentru profil, articole, comentarii și moderare verifică CSRF.
  Numele/comentariile sunt texte simple escapate în EJS, fără HTML executabil.
  Comentariile au limită de 2.000 de caractere, honeypot și confirmare de afișare publică.
- Topul Super Adminului folosește afișările deja înregistrate. Nu reprezintă cititori
  unici, lecturi complete sau indexare în motoarele de căutare.

### Stocarea comentariilor și limitele pilotului

`comment-store.js` folosește **același serviciu Netlify Blobs**, într-un store separat
`campanie-comments`. Comentariile și evenimentele de moderare sunt
obiecte independente cu UUID-uri, nu array-uri rescrise în `campanie-db/db`.
Trimiterile simultane nu suprascriu comentariile celorlalți. Moderările concurente sunt
păstrate în audit; versiunea învechită este respinsă dacă schimbarea este deja vizibilă.
Dacă două moderări trec verificarea simultan, se aplică ordinea dată de timestamp și UUID;
o ștergere logică are întotdeauna prioritate. Nu există tranzacții distribuite în acest lot.

SDK-ul 8.2 deja inclus nu propagă endpoint-ul necesar consistenței `strong` prin
`connectLambda`. Nu schimbăm SDK-ul sau handlerul: folosim exclusiv chei noi pentru
comentarii/moderare, fără actualizări. Conform [documentației Netlify Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/#consistency),
obiectele noi devin disponibile imediat și în modul implicit; actualizările/ștergerile
pot necesita până la 60 de secunde. Singurele ștergeri fizice din acest modul sunt
marcajele anti-spam expirate, care nu controlează vizibilitatea comentariilor.

În contexte Netlify non-producție se folosește un store de comentarii limitat la deploy;
comentariile de test nu ajung în store-ul de producție. Local se folosește
`data/comments/`, exclus din Git. Erorile Blobs nu declanșează scrieri pe discul Lambda.
**Izolarea aceasta privește comentariile; store-ul principal existent nu a fost schimbat.**

Anti-spamul necesită `SESSION_SECRET` aleatoriu, cu minimum 32 de caractere. Se urmărește
o trimitere/minut și 10/zi per identificator de conexiune pseudonimizat prin HMAC cu cheie
secretă și dată. Nu se stochează IP-ul brut sau legătura identificatorului cu textul.
Marcajele zilelor mai vechi decât ziua precedentă sunt șterse la următoarea trimitere
validă; fără trafic nu există un job de ștergere automată. Limita este **best-effort**:
cererile care sosesc exact simultan pot depăși pragul, iar persoanele care împart aceeași
conexiune pot împărți și limita. Nu este protecție DDoS. Identificarea conexiunii prin
header-ul Netlify trebuie verificată pe deploy; local se folosește adresa socketului.

La afișarea publică se citesc comentariile/auditul articolului; în administrare se citește
întreaga listă înainte de paginare. Soluția este pentru pilot, nu pentru volume mari.
Modelul vechi `db.json` pentru conturi, articole și statistici rămâne neschimbat:
instanțe serverless diferite pot păstra copii vechi și suprascrie actualizări concurente.
Acest lot **nu rezolvă** acea problemă generală de stocare sau securitatea completă a
rutelor vechi. Este necesară o intervenție separată, aprobată, înainte de extindere.

### Verificarea acestui lot

```bash
node --test tests/*.test.js
```

Testele folosesc directoare temporare, conturi fictive, ceas controlat și adaptoare de
stocare simulate. Un test folosește SDK-ul Blobs real și `connectLambda`, cu transport
HTTP simulat, inclusiv izolarea preview/producție și paginarea. Acoperă fusul orar/DST, vizibilitatea la termen, căutarea, contactul,
CSRF, izolarea între candidați, moderarea/XSS, auditul, anti-spamul și scrieri simultane.
Nu trimit mesaje către furnizori sociali și nu ating date de producție.

După aprobarea publicării trebuie verificat pe Netlify: programarea unui articol în
viitor, accesul înainte/după termen, comentariu nou → reîncărcare → aprobare → reîncărcare,
apoi respingere/ștergere și persistență după repornirea funcției. Testele locale nu
înlocuiesc aceste verificări. Politica de moderare, retenția și informarea privind datele
trebuie validate înainte de folosirea reală; funcțiile tehnice nu certifică legalitatea.

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

Deschide `http://localhost:3000`. La o instalare nouă, setează în `.env`
`INITIAL_ADMIN_PASSWORD` la o parolă unică de minimum 12 caractere. Adresa implicită
este `admin@platforma.ro` și poate fi schimbată cu `INITIAL_ADMIN_EMAIL`. Parola nu este
scrisă în cod și nu este afișată în loguri.

## Deploy pe Netlify (prin GitHub)

1. Publici acest folder pe un repo GitHub (vezi `PROMPT_PENTRU_CHATGPT.md` pentru pașii
   exacți, dacă vrei să delegi asta către un executor precum ChatGPT/Claude Code).
2. Pe [app.netlify.com](https://app.netlify.com): „Add new site” → „Import an existing
   project” → alegi repo-ul de GitHub.
3. Netlify detectează automat `netlify.toml`. Nu trebuie schimbat nimic la setările de
   build.
4. La „Site settings → Environment variables”, adaugi:
   - `SESSION_SECRET` — un text lung, aleatoriu (necesar pentru sesiuni sigure)
   - `INITIAL_ADMIN_PASSWORD` — numai pentru crearea Super Adminului la prima pornire;
     minimum 12 caractere, păstrată ca secret
   - `INITIAL_ADMIN_EMAIL` — opțional; implicit `admin@platforma.ro`
   - `OAUTH_ENCRYPTION_KEY` — alt text lung, aleatoriu, de minimum 32 de caractere;
     nu îl schimba după ce utilizatorii și-au conectat conturile
   - `META_APP_ID` și `META_APP_SECRET` — din aplicația Meta
   - `META_GRAPH_VERSION` — opțional; implicit `v26.0`
   - `TIKTOK_CLIENT_KEY` și `TIKTOK_CLIENT_SECRET` — din aplicația TikTok
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

## Configurarea furnizorilor sociali

- În Meta for Developers înregistrezi exact callback-ul public
  `https://DOMENIUL-TAU/oauth/meta/callback` și soliciți permisiunile
  `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic` și
  `instagram_content_publish`. Instagram trebuie să fie cont profesional asociat Paginii.
- În TikTok for Developers înregistrezi exact callback-ul
  `https://DOMENIUL-TAU/oauth/tiktok/callback`, activezi Login Kit și Content Posting API
  și soliciți `user.info.basic` și `video.publish`. Domeniul imaginilor trimise prin URL
  trebuie verificat la TikTok. Clienții neauditați sunt limitați la publicare privată.
- Candidații intră în `Dashboard → Centru social`, conectează conturile și confirmă
  fiecare publicare. Nu există postare automată fără acțiunea candidatului.

## Ce NU este încă inclus (pași următori)

- Conectarea domeniilor proprii ale candidaților (`anamarinescu.ro` → subdomeniul
  platformei) — se face din Netlify, „Domain settings → Add custom domain”, per candidat.
- Programarea distribuirilor sociale și încărcarea directă de fișiere media. Articolele
  de pe site pot fi programate; distribuirea socială rămâne manuală și confirmată.
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
publication.js            - validare, căutare, date și vizibilitate la termen
comments.js               - moderare, audit și anti-spam
comment-store.js          - comentarii independente, local / Netlify Blobs
tests/                    - verificări automate izolate
netlify.toml              - configurare Netlify
middleware/auth.js        - protectia rutelor pe roluri (admin / candidat)
views/                    - paginile HTML (EJS)
public/style.css          - stilurile pentru admin, dashboard si site public
```
