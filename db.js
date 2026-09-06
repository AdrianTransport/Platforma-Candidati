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
