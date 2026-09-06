import bcrypt from 'bcryptjs';
import { readData, writeData } from './store.js';

export const db = {
  data: null,
  async read() {
    this.data = await readData();
  },
  async write() {
    await writeData(this.data);
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
  for (let i = 0; i < 10; i++) {
    parola += chars[Math.floor(Math.random() * chars.length)];
  }
  return parola;
}

export async function initDB() {
  await db.read();
  db.data ||= { users: [], articole: [], nextUserId: 1, nextArticolId: 1 };
  db.data.users ||= [];
  db.data.articole ||= [];
  db.data.nextUserId ||= 1;
  db.data.nextArticolId ||= 1;

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
    user.module = { site: true, statistici: true, social: true, ...(user.module || {}) };
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
  }

  const areAdmin = db.data.users.some((u) => u.role === 'admin');
  if (!areAdmin) {
    db.data.users.push({
      id: db.data.nextUserId++,
      email: 'admin@platforma.ro',
      password_hash: bcrypt.hashSync('admin123', 10),
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
    await db.write();
    console.log('Cont admin implicit creat: admin@platforma.ro / admin123 (schimba parola dupa prima logare)');
  }
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
