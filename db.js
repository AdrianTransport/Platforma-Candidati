import bcrypt from 'bcryptjs';
import { readDataSnapshot, writeData } from './store.js';

export const db = {
  data: null,
  version: undefined,
  committed: null,
  requiresReload: false,
  async read() {
    const snapshot = await readDataSnapshot();
    this.data = snapshot.data;
    this.version = snapshot.version;
    this.committed = structuredClone(snapshot.data);
    this.requiresReload = false;
  },
  async write() {
    const pending = structuredClone(this.data);
    try {
      this.version = await writeData(pending, this.version);
      this.committed = pending;
    } catch (error) {
      // O salvare respinsă nu trebuie să rămână vizibilă numai în memorie și
      // nici să fie inclusă accidental într-o salvare ulterioară.
      this.data = structuredClone(this.committed);
      this.version = undefined;
      this.requiresReload = true;
      throw error;
    }
  },
};

// Genereaza un subdomeniu simplu dintr-un nume (fara diacritice, cu cratime)
export function slugify(text) {
  return text
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export function generateazaParola() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let parola = '';
  for (let i = 0; i < 16; i++) {
    parola += chars[Math.floor(Math.random() * chars.length)];
  }
  return parola;
}

export async function initDB() {
  await db.read();
  db.data ||= { users: [], articole: [], portal_posts: [], nextUserId: 1, nextArticolId: 1, nextPortalPostId: 1 };
  db.data.users ||= [];
  db.data.articole ||= [];
  db.data.portal_posts ||= [];
  db.data.polls ||= [];
  db.data.raportari_costuri ||= [];
  db.data.raportari_costuri_arhiva ||= [];
  db.data.nextUserId ||= 1;
  db.data.nextArticolId ||= 1;
  db.data.nextPortalPostId ||= 1;
  db.data.nextPollId ||= 1;
  db.data.nextRaportareId ||= 1;

  // Approved profile-image update. Match the previous image exactly so a later
  // dashboard edit (including removing the photo) is never overwritten.
  const updatedProfile = db.data.users.find(user => user.role === 'candidate'
    && user.subdomeniu === 'daniel-ganea'
    && user.fotografie_profil_url === '/media/fefd679d-edd5-4b3c-9cd2-20eb1e7613c1');
  if (updatedProfile) {
    updatedProfile.fotografie_profil_url = 'https://vocealenauheim.ro/candidate-assets/daniel-ganea-20260911.png';
  }

  for (const user of db.data.users) {
    user.login_attempts ||= 0;
    user.locked_until ||= null;
    user.last_login_at ||= null;
  }

  // Completeaza in mod sigur campurile introduse dupa prima versiune, fara sa
  // stearga sau sa rescrie datele deja existente in Netlify Blobs.
  for (const user of db.data.users) {
    if (user.role !== 'candidate') continue;
    user.status_cont ||= user.activ === false ? 'suspendat' : 'activ';
    user.functie_candidatura ||= '';
    user.judet ||= '';
    user.partid ||= '';
    user.slogan ||= '';
    user.descriere ||= '';
    user.facebook_url ||= '';
    user.instagram_url ||= '';
    user.tiktok_url ||= '';
    user.youtube_url ||= '';
    user.fotografie_profil_url ||= '';
    user.fotografie_coperta_url ||= '';
    user.tip_candidat ||= '';
    user.entitate_responsabila ||= '';
    user.finantator_materiale ||= '';
    user.scrutin ||= '';
    user.cod_mandatar_financiar ||= '';
    user.tip_contract ||= '';
    user.numar_contract ||= '';
    user.data_contract ||= '';
    user.valoare_contract = Number(user.valoare_contract) || 0;
    user.moneda_contract ||= 'RON';
    user.campanie_start ||= '';
    user.campanie_end ||= '';
    user.confirmare_mandatar ||= false;
    user.terms_version ||= '';
    user.terms_accepted_at ||= null;
    user.editorial_responsibility_accepted_at ||= null;
    user.social_connections = {
      meta: null,
      tiktok: null,
      ...(user.social_connections || {}),
    };
    user.module = { site: true, statistici: true, social: true, ...(user.module || {}) };
    // Păstrează afișarea candidaților deja activi; conturile noi pornesc ascunse.
    user.vizibil_in_portal ??= Boolean(user.activ && user.status_cont === 'activ' && user.module.site);
    user.statistici = {
      vizite_site: user.statistici?.vizite_site || 0,
      surse: {
        direct: 0,
        facebook: 0,
        instagram: 0,
        tiktok: 0,
        altele: 0,
        ...(user.statistici?.surse || {}),
      },
      clickuri_sociale: {
        facebook: 0,
        instagram: 0,
        tiktok: 0,
        youtube: 0,
        ...(user.statistici?.clickuri_sociale || {}),
      },
    };
  }

  for (const articol of db.data.articole) {
    articol.vizualizari ||= 0;
    articol.imagine_url ||= '';
    articol.distribuiri_sociale ||= [];
    articol.moderation_status ||= 'normal';
    articol.transparenta ||= null;
    articol.reactii ||= { like: 0, dislike: 0, voters: {} };
    articol.reactii.voters ||= {};
  }

  for (const post of db.data.portal_posts) {
    post.vizualizari ||= 0;
    post.imagine_url ||= '';
    post.imagine_alt ||= '';
    post.imagine_legenda ||= '';
    post.imagine_credit ||= '';
    post.imagine_generata_ai ||= false;
    post.generat_de_ai ||= false;
    post.principal ||= false;
    post.reactii ||= { like: 0, dislike: 0, voters: {} };
    post.reactii.voters ||= {};
    post.status ||= 'ciorna';
    post.tip ||= 'stire';
  }

  const areAdmin = db.data.users.some((u) => u.role === 'admin');
  if (!areAdmin) {
    const parolaInitiala = String(process.env.INITIAL_ADMIN_PASSWORD || '');
    if (parolaInitiala.length < 12) {
      throw new Error('La prima pornire, configureaza INITIAL_ADMIN_PASSWORD cu minimum 12 caractere.');
    }
    db.data.users.push({
      id: db.data.nextUserId++,
      email: String(process.env.INITIAL_ADMIN_EMAIL || 'admin@platforma.ro').trim().toLowerCase(),
      password_hash: bcrypt.hashSync(parolaInitiala, 12),
      role: 'admin',
      nume_candidat: null,
      zona: null,
      subdomeniu: null,
      mesaj_scurt: null,
      domeniu_custom: null,
      activ: true,
      login_attempts: 0,
      locked_until: null,
      last_login_at: null,
      created_at: new Date().toISOString(),
    });
  }
  if (!areAdmin || updatedProfile) await db.write();
}

export function nextUserId() {
  const id = db.data.nextUserId;
  db.data.nextUserId += 1;
  return id;
}

export function nextArticolId() {
  const id = db.data.nextArticolId;
  db.data.nextArticolId += 1;
  return id;
}

export function nextPortalPostId() {
  const id = db.data.nextPortalPostId;
  db.data.nextPortalPostId += 1;
  return id;
}
