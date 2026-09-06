import express from 'express';
import cookieSession from 'cookie-session';
import bcrypt from 'bcryptjs';
import path from 'path';
import { db, initDB, slugify, generateazaParola, nextUserId, nextArticolId } from './db.js';
import { requireRole } from './middleware/auth.js';

// Folosim process.cwd() in loc de fileURLToPath(import.meta.url): dupa ce Netlify
// impacheteaza functia cu esbuild, import.meta.url poate deveni undefined si arunca
// eroare la pornire. process.cwd() functioneaza identic local si pe Netlify, atata
// timp cat "views" si "public" sunt incluse in pachetul functiei (vezi netlify.toml).
const baseDir = process.cwd();

export async function createApp() {
  await initDB();

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(baseDir, 'views'));
  app.use(express.static(path.join(baseDir, 'public')));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // Sesiune stocata in cookie semnat (fara memorie pe server) - functioneaza
  // identic local si pe functii serverless (Netlify).
  app.use(
    cookieSession({
      name: 'sesiune',
      keys: [process.env.SESSION_SECRET || 'schimba-acest-secret-in-productie'],
      maxAge: 1000 * 60 * 60 * 8, // 8 ore
    })
  );

  app.use((req, res, next) => {
    res.locals.userId = req.session.userId || null;
    res.locals.rol = req.session.rol || null;
    res.locals.numeCandidat = req.session.numeCandidat || null;
    next();
  });

  /* ---------------------------- AUTENTIFICARE ---------------------------- */

  app.get('/login', (req, res) => {
    res.render('login', { eroare: null });
  });

  app.post('/login', async (req, res) => {
    const { email, parola } = req.body;
    const user = db.data.users.find((u) => u.email === email && u.activ);
    if (!user || !bcrypt.compareSync(parola, user.password_hash)) {
      return res.render('login', { eroare: 'Email sau parola incorecte.' });
    }
    req.session.userId = user.id;
    req.session.rol = user.role;
    req.session.numeCandidat = user.nume_candidat;
    if (user.role === 'admin') return res.redirect('/admin');
    return res.redirect('/dashboard');
  });

  app.post('/logout', (req, res) => {
    req.session = null;
    res.redirect('/login');
  });

  app.get('/', (req, res) => res.redirect('/login'));

  /* -------------------------------- ADMIN -------------------------------- */

  app.get('/admin', requireRole('admin'), (req, res) => {
    const candidati = db.data.users.filter((u) => u.role === 'candidate');
    res.render('admin-dashboard', {
      candidati,
      parolaNoua: req.query.parolaNoua || null,
      emailNou: req.query.emailNou || null,
    });
  });

  app.post('/admin/candidati', requireRole('admin'), async (req, res) => {
    const { nume_candidat, email, zona } = req.body;
    if (!nume_candidat || !email) return res.redirect('/admin');
    let subdomeniu = slugify(nume_candidat);
    let contor = 1;
    while (db.data.users.some((u) => u.subdomeniu === subdomeniu)) {
      subdomeniu = `${slugify(nume_candidat)}-${contor++}`;
    }
    const parola = generateazaParola();
    db.data.users.push({
      id: nextUserId(),
      email,
      password_hash: bcrypt.hashSync(parola, 10),
      role: 'candidate',
      nume_candidat,
      zona: zona || '',
      subdomeniu,
      mesaj_scurt: '',
      domeniu_custom: null,
      activ: true,
      created_at: new Date().toISOString(),
    });
    await db.write();
    res.redirect(`/admin?parolaNoua=${encodeURIComponent(parola)}&emailNou=${encodeURIComponent(email)}`);
  });

  app.post('/admin/candidati/:id/dezactiveaza', requireRole('admin'), async (req, res) => {
    const user = db.data.users.find((u) => u.id === Number(req.params.id));
    if (user) {
      user.activ = !user.activ;
      await db.write();
    }
    res.redirect('/admin');
  });

  /* ------------------------------ CANDIDAT ------------------------------- */

  app.get('/dashboard', requireRole('candidate'), (req, res) => {
    const articole = db.data.articole
      .filter((a) => a.user_id === req.session.userId)
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    const user = db.data.users.find((u) => u.id === req.session.userId);
    res.render('candidate-dashboard', { articole, user });
  });

  app.get('/dashboard/articol/nou', requireRole('candidate'), (req, res) => {
    res.render('articol-form', { articol: null });
  });

  app.get('/dashboard/articol/:id/edit', requireRole('candidate'), (req, res) => {
    const articol = db.data.articole.find(
      (a) => a.id === Number(req.params.id) && a.user_id === req.session.userId
    );
    if (!articol) return res.redirect('/dashboard');
    res.render('articol-form', { articol });
  });

  app.post('/dashboard/articol', requireRole('candidate'), async (req, res) => {
    const { titlu, continut, tip, categorie, generat_de_ai, status } = req.body;
    const acum = new Date().toISOString();
    db.data.articole.push({
      id: nextArticolId(),
      user_id: req.session.userId,
      tip: tip || 'idee',
      titlu,
      continut,
      categorie: categorie || 'Actualitate',
      status: status === 'publicat' ? 'publicat' : 'ciorna',
      generat_de_ai: generat_de_ai === 'true',
      data_publicare: acum,
      updated_at: acum,
    });
    await db.write();
    res.redirect('/dashboard');
  });

  app.post('/dashboard/articol/:id', requireRole('candidate'), async (req, res) => {
    const articol = db.data.articole.find(
      (a) => a.id === Number(req.params.id) && a.user_id === req.session.userId
    );
    if (!articol) return res.redirect('/dashboard');
    const { titlu, continut, tip, categorie, generat_de_ai, status } = req.body;
    articol.titlu = titlu;
    articol.continut = continut;
    articol.tip = tip || articol.tip;
    articol.categorie = categorie || articol.categorie;
    articol.generat_de_ai = generat_de_ai === 'true';
    const eraDejaPublicat = articol.status === 'publicat';
    articol.status = status === 'publicat' ? 'publicat' : 'ciorna';
    if (!eraDejaPublicat && articol.status === 'publicat') {
      articol.data_publicare = new Date().toISOString();
    }
    articol.updated_at = new Date().toISOString();
    await db.write();
    res.redirect('/dashboard');
  });

  app.post('/dashboard/articol/:id/sterge', requireRole('candidate'), async (req, res) => {
    db.data.articole = db.data.articole.filter(
      (a) => !(a.id === Number(req.params.id) && a.user_id === req.session.userId)
    );
    await db.write();
    res.redirect('/dashboard');
  });

  app.post('/dashboard/genereaza-ai', requireRole('candidate'), async (req, res) => {
    const { idee, ton } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(400).json({
        eroare: 'Nu este configurata ANTHROPIC_API_KEY. Vezi README.md pentru instructiuni.',
      });
    }
    try {
      const raspuns = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 700,
          messages: [
            {
              role: 'user',
              content: `Esti asistentul de comunicare al unui candidat local la alegeri din Romania. Scrie un articol scurt (120-180 de cuvinte), in limba romana, ton ${ton || 'direct si apropiat'}, plecand de la aceasta idee data de candidat: "${idee}".
Reguli stricte:
- Nu inventa cifre, date sau promisiuni concrete pe care candidatul nu le-a mentionat.
- Nu ataca alti candidati sau partide.
- Nu folosi limbaj de campanie negativa sau afirmatii neverificabile.
- Scrie la persoana intai, ca si cum candidatul insusi ar vorbi.
Raspunde DOAR cu doua linii:
Titlu: <titlul articolului>
Text: <continutul articolului>`,
            },
          ],
        }),
      });
      if (!raspuns.ok) {
        const detalii = await raspuns.text();
        return res.status(502).json({ eroare: 'Eroare de la API-ul Claude.', detalii });
      }
      const data = await raspuns.json();
      const text = data.content?.find((b) => b.type === 'text')?.text || '';
      const potrivireTitlu = text.match(/Titlu:\s*(.+)/i);
      const potrivireText = text.match(/Text:\s*([\s\S]+)/i);
      res.json({
        titlu: potrivireTitlu ? potrivireTitlu[1].trim() : 'Titlu generat de AI',
        continut: potrivireText ? potrivireText[1].trim() : text.trim(),
      });
    } catch (err) {
      res.status(500).json({ eroare: 'Nu am putut contacta API-ul Claude.', detalii: String(err) });
    }
  });

  /* --------------------------- SITE PUBLIC (ziar) -------------------------- */

  app.get('/site/:subdomeniu', (req, res) => {
    const user = db.data.users.find(
      (u) => u.subdomeniu === req.params.subdomeniu && u.role === 'candidate' && u.activ
    );
    if (!user) return res.status(404).send('Pagina nu exista.');
    const toate = db.data.articole
      .filter((a) => a.user_id === user.id && a.status === 'publicat')
      .sort((a, b) => new Date(b.data_publicare) - new Date(a.data_publicare));
    const candidatura = toate.find((a) => a.tip === 'candidatura');
    const fluxIdei = toate.filter((a) => a.tip !== 'candidatura');
    res.render('site-public', { user, candidatura, fluxIdei });
  });

  app.get('/site/:subdomeniu/articol/:id', (req, res) => {
    const user = db.data.users.find((u) => u.subdomeniu === req.params.subdomeniu && u.activ);
    if (!user) return res.status(404).send('Pagina nu exista.');
    const articol = db.data.articole.find(
      (a) => a.id === Number(req.params.id) && a.user_id === user.id && a.status === 'publicat'
    );
    if (!articol) return res.status(404).send('Articolul nu exista sau nu e publicat.');
    res.render('site-articol', { user, articol });
  });

  return app;
}
