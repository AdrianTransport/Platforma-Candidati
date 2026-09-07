// Datele introduse în formular sunt întotdeauna în ora României, nu a serverului.
export const TIME_ZONE = 'Europe/Bucharest';
const formatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export class ValidationError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function textField(value, label, max, required = false) {
  if (value == null) value = '';
  if (typeof value !== 'string') throw new ValidationError(`${label}: valoare invalidă.`);
  const result = value.trim();
  if (result.length > max || (required && !result)) {
    throw new ValidationError(`${label}: ${required ? 'completează câmpul; ' : ''}maximum ${max} caractere.`);
  }
  return result;
}

export function localDateTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function displayDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Date(value).toLocaleString('ro-RO', { timeZone: TIME_ZONE, dateStyle: 'medium', timeStyle: 'short' });
}

export function parseScheduledDate(value, now = Date.now()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    throw new ValidationError('Alege data și ora publicării în fusul Europe/Bucharest.');
  }
  // România folosește UTC+2 iarna și UTC+3 vara. Verificăm fiecare candidat cu
  // baza IANA a runtime-ului; respingem ore inexistente sau duble la schimbarea orei.
  const wall = Date.parse(`${value}:00Z`);
  const matches = [2, 3].map(offset => wall - offset * 3600000)
    .filter(time => Number.isFinite(time) && localDateTime(new Date(time).toISOString()) === value);
  if (matches.length !== 1) {
    throw new ValidationError('Ora aleasă nu există sau este ambiguă la schimbarea orei. Alege o altă oră.');
  }
  if (matches[0] <= now) throw new ValidationError('Data programată trebuie să fie în viitor (ora României).');
  return new Date(matches[0]).toISOString();
}

export function isPublished(article, now = Date.now()) {
  if (article.moderation_status === 'suspendat') return false;
  if (article.status === 'publicat') return true;
  return article.status === 'programat' && Number.isFinite(Date.parse(article.data_programata))
    && Date.parse(article.data_programata) <= now;
}

export function publicationDate(article) {
  return article.status === 'programat' ? article.data_programata : article.data_publicare;
}

export function articleInput(body, previous = null, now = Date.now()) {
  const titlu = textField(body.titlu, 'Titlu', 200, true);
  const continut = textField(body.continut, 'Conținut', 30000, true);
  const categorie = textField(body.categorie || 'Actualitate', 'Categorie', 60, true);
  const tip = body.tip || previous?.tip || 'idee';
  const status = body.status;
  if (!['idee', 'candidatura', 'anunt'].includes(tip)) throw new ValidationError('Tip de articol invalid.');
  if (!['ciorna', 'publicat', 'programat'].includes(status)) throw new ValidationError('Alege cum salvezi articolul.');
  const scheduled = status === 'programat' ? parseScheduledDate(body.data_programata, now) : null;
  return {
    titlu, continut, categorie, tip, status, data_programata: scheduled,
    generat_de_ai: body.generat_de_ai === 'true',
    rezumat: textField(body.rezumat, 'Rezumat', 300),
    imagine_alt: textField(body.imagine_alt, 'Descriere imagine', 240),
    imagine_legenda: textField(body.imagine_legenda, 'Legendă imagine', 300),
    imagine_credit: textField(body.imagine_credit, 'Sursa imaginii', 160),
    imagine_generata_ai: body.imagine_generata_ai === 'true',
    data_publicare: status === 'publicat'
      ? (previous && isPublished(previous, now) ? publicationDate(previous) : new Date(now).toISOString())
      : null,
    updated_at: new Date(now).toISOString(),
  };
}

export function profileInput(body) {
  const email_contact = textField(body.email_contact, 'Email public', 254).toLowerCase();
  const telefon_contact = textField(body.telefon_contact, 'Telefon public', 30);
  if (email_contact && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email_contact)) {
    throw new ValidationError('Adresa de email publică nu este validă.');
  }
  if (telefon_contact && (!/^\+?[\d ()\-]+$/.test(telefon_contact)
    || !/^\d{7,15}$/.test(telefon_contact.replace(/\D/g, '')))) {
    throw new ValidationError('Telefonul public trebuie să conțină între 7 și 15 cifre.');
  }
  return {
    functie_candidatura: textField(body.functie_candidatura, 'Funcție', 120),
    zona: textField(body.zona, 'Localitate / zonă', 120),
    judet: textField(body.judet, 'Județ', 80),
    slogan: textField(body.slogan, 'Slogan', 140),
    mesaj_scurt: textField(body.mesaj_scurt, 'Mesaj scurt', 240),
    descriere: textField(body.descriere, 'Prezentare', 2000),
    email_contact, telefon_contact,
  };
}

const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('ro');
export function filterArticles(articles, query) {
  const cautaText = textField(query.cauta, 'Căutare', 120);
  const categorieSelectata = textField(query.categorie, 'Categorie', 60);
  const filtrate = articles.filter(a => (!categorieSelectata || a.categorie === categorieSelectata)
    && (!cautaText || fold(`${a.titlu} ${a.continut}`).includes(fold(cautaText))));
  return { cautaText, categorieSelectata, filtrate };
}
