import { textField, ValidationError } from './publication.js';

export const RETENTION_DAYS = 90;
export const MAX_RAPORTARI_PER_IP = 3;
export const MIN_RASPUNSURI_PUBLICE = 5;
export const LOCALITATI = ['Bulgăruș', 'Lenauheim', 'Grabaț'];

// Sumele publicate sunt rotunjite pe intervale de 50 lei, ca sa nu poata fi
// combinate cu alte detalii (localitate mica, perioada) pentru identificarea
// unei persoane anume dupa suma exacta platita.
export function bucketSuma(suma) {
  const treapta = 50;
  const inceput = Math.floor(suma / treapta) * treapta;
  return `${inceput}-${inceput + treapta} lei`;
}

export function esteExpirata(raportare, now = Date.now()) {
  const varstaZile = (now - new Date(raportare.created_at).getTime()) / (1000 * 60 * 60 * 24);
  return varstaZile > RETENTION_DAYS;
}

// Dupa termenul de retentie, elimina inregistrarea individuala si toate
// datele care pot identifica expeditorul. Pastreaza permanent doar o
// statistica anonima agregata pe serviciu, localitate, perioada si interval.
export function purjeazaRaportariExpirate(db, now = Date.now()) {
  db.data.raportari_costuri_arhiva ||= [];
  const active = [];
  let schimbat = false;
  for (const raportare of db.data.raportari_costuri) {
    if (!esteExpirata(raportare, now)) {
      active.push(raportare);
      continue;
    }
    const sumaInterval = bucketSuma(raportare.suma);
    const agregat = db.data.raportari_costuri_arhiva.find((r) => r.tip === raportare.tip
      && r.localitate === raportare.localitate && r.perioada === raportare.perioada
      && r.suma_interval === sumaInterval);
    if (agregat) {
      agregat.numar_raportari += 1;
      agregat.suma_totala += raportare.suma;
    } else {
      db.data.raportari_costuri_arhiva.push({
        tip: raportare.tip,
        localitate: raportare.localitate,
        perioada: raportare.perioada,
        suma_interval: sumaInterval,
        numar_raportari: 1,
        suma_totala: raportare.suma,
      });
    }
    schimbat = true;
  }
  db.data.raportari_costuri = active;
  return schimbat;
}

export function limitaRaportariDepasita(raportari, tip, ipHash, now = Date.now()) {
  return raportari.filter((r) => r.tip === tip && r.ip_hash === ipHash && !esteExpirata(r, now)).length
    >= MAX_RAPORTARI_PER_IP;
}

export function descriereDispozitiv(userAgent = '') {
  const ua = String(userAgent);
  const dispozitiv = /iPad|Android(?!.*Mobile)/i.test(ua) ? 'Tabletă'
    : /iPhone|iPod/i.test(ua) ? 'Telefon iPhone'
      : /Android.*Mobile/i.test(ua) ? 'Telefon Android' : 'Calculator';
  const sistem = /Windows/i.test(ua) ? 'Windows' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS/iPadOS'
    : /Android/i.test(ua) ? 'Android' : /Mac OS X|Macintosh/i.test(ua) ? 'macOS'
      : /Linux/i.test(ua) ? 'Linux' : 'sistem necunoscut';
  const browser = /Edg\//i.test(ua) ? 'Edge' : /Firefox\//i.test(ua) ? 'Firefox'
    : /Chrome\//i.test(ua) ? 'Chrome' : /Safari\//i.test(ua) ? 'Safari' : 'browser necunoscut';
  return `${dispozitiv} · ${sistem} · ${browser}`;
}

export function raportareInput(body, tip) {
  if (!['apa', 'salubritate'].includes(tip)) throw new ValidationError('Tip de raportare invalid.');
  if (body.confirmare_informare !== 'on' && body.confirmare_informare !== true) {
    throw new ValidationError('Trebuie să confirmi că ai citit informarea de confidențialitate și că datele trimise sunt reale.');
  }
  const localitate = textField(body.localitate, 'Localitate', 60, true);
  if (!LOCALITATI.includes(localitate)) throw new ValidationError('Localitate invalidă.');
  const perioada = textField(body.perioada, 'Perioadă', 40, true);
  const sumaBruta = String(body.suma ?? '').replace(',', '.').trim();
  const suma = Number(sumaBruta);
  if (!Number.isFinite(suma) || suma <= 0 || suma > 100000) {
    throw new ValidationError('Suma trebuie să fie un număr valid, mai mare decât 0.');
  }
  const modRaspuns = String(body.mod_raspuns || '').trim();
  if (!['anonim', 'nume'].includes(modRaspuns)) {
    throw new ValidationError('Alege dacă răspunzi anonim sau cu numele tău.');
  }
  let nume = '';
  if (modRaspuns === 'nume') {
    nume = textField(body.nume, 'Nume', 120, true);
    if (body.acord_stocare_nume !== 'on' && body.acord_stocare_nume !== true) {
      throw new ValidationError('Trebuie să confirmi acordul pentru stocarea confidențială a numelui.');
    }
  }
  const comun = {
    id: null, // atribuit de apelant
    tip,
    localitate,
    perioada,
    suma,
    nume, // privat - niciodata afisat public, vezi vizualizarePublica()
    mod_raspuns: modRaspuns,
    observatii: textField(body.observatii, 'Observații', 500),
    created_at: new Date().toISOString(),
  };
  if (tip === 'apa') {
    const consumBruta = String(body.consum_mc ?? '').replace(',', '.').trim();
    const consum_mc = consumBruta ? Number(consumBruta) : null;
    if (consum_mc !== null && (!Number.isFinite(consum_mc) || consum_mc < 0 || consum_mc > 10000)) {
      throw new ValidationError('Consumul în m³ trebuie să fie un număr valid.');
    }
    const persoaneBruta = String(body.numar_persoane ?? '').trim();
    const numar_persoane = persoaneBruta ? Number(persoaneBruta) : null;
    if (numar_persoane !== null && (!Number.isInteger(numar_persoane) || numar_persoane < 1 || numar_persoane > 30)) {
      throw new ValidationError('Numărul de persoane trebuie să fie un întreg valid.');
    }
    return { ...comun, consum_mc, numar_persoane };
  }
  // salubritate
  const tipPlatitor = String(body.tip_platitor || '').trim();
  if (!['fizica', 'juridica'].includes(tipPlatitor)) {
    throw new ValidationError('Alege dacă ești persoană fizică sau juridică.');
  }
  const persoaneBruta = String(body.numar_persoane ?? '').trim();
  const numar_persoane = persoaneBruta ? Number(persoaneBruta) : null;
  if (numar_persoane !== null && (!Number.isInteger(numar_persoane) || numar_persoane < 1 || numar_persoane > 30)) {
    throw new ValidationError('Numărul de persoane trebuie să fie un întreg valid.');
  }
  return { ...comun, tip_platitor: tipPlatitor, numar_persoane };
}

// Super Adminul poate corecta numai datele folosite în statistică. Datele
// confidențiale ale persoanei (nume, IP, dispozitiv) rămân nemodificate.
export function moderareRaportareInput(body, tip) {
  if (!['apa', 'salubritate'].includes(tip)) throw new ValidationError('Tip de raportare invalid.');
  const localitate = textField(body.localitate, 'Localitate', 60, true);
  if (!LOCALITATI.includes(localitate)) throw new ValidationError('Localitate invalidă.');
  const perioada = textField(body.perioada, 'Perioadă', 40, true);
  const suma = Number(String(body.suma ?? '').replace(',', '.').trim());
  if (!Number.isFinite(suma) || suma <= 0 || suma > 100000) {
    throw new ValidationError('Suma trebuie să fie un număr valid, mai mare decât 0 și de cel mult 100.000 lei.');
  }
  const persoaneBruta = String(body.numar_persoane ?? '').trim();
  const numar_persoane = persoaneBruta ? Number(persoaneBruta) : null;
  if (numar_persoane !== null && (!Number.isInteger(numar_persoane) || numar_persoane < 1 || numar_persoane > 30)) {
    throw new ValidationError('Numărul de persoane trebuie să fie un întreg valid.');
  }
  if (tip === 'apa') {
    const consumBruta = String(body.consum_mc ?? '').replace(',', '.').trim();
    const consum_mc = consumBruta ? Number(consumBruta) : null;
    if (consum_mc !== null && (!Number.isFinite(consum_mc) || consum_mc < 0 || consum_mc > 10000)) {
      throw new ValidationError('Consumul în m³ trebuie să fie un număr valid.');
    }
    return { localitate, perioada, suma, consum_mc, numar_persoane };
  }
  const tip_platitor = String(body.tip_platitor || '').trim();
  if (!['fizica', 'juridica'].includes(tip_platitor)) {
    throw new ValidationError('Alege dacă raportarea este pentru persoană fizică sau juridică.');
  }
  return { localitate, perioada, suma, tip_platitor, numar_persoane };
}

// Suma totala raportata pentru un tip (apa/salubritate), afisata public.
// Aplicam acelasi prag minim de raspunsuri ca la statisticile pe grup, ca sa
// nu devina posibila identificarea unei persoane cand sunt foarte putine
// raportari in total (ex: daca stii ca e un singur raspuns, suma totala
// exacta iti spune exact cat a platit acea persoana).
export function totalPublic(raportari, tip, arhiva = []) {
  const ale_tipului = raportari.filter((r) => r.tip === tip);
  const arhivate = arhiva.filter((r) => r.tip === tip);
  const numarRaspunsuri = ale_tipului.length + arhivate.reduce((acc, r) => acc + r.numar_raportari, 0);
  if (numarRaspunsuri < MIN_RASPUNSURI_PUBLICE) return null;
  return {
    suma: ale_tipului.reduce((acc, r) => acc + r.suma, 0) + arhivate.reduce((acc, r) => acc + r.suma_totala, 0),
    numarRaspunsuri,
  };
}
// Agrega raportarile pentru afisare publica - fara nume si fara sume exacte.
// Fiecare grup devine vizibil de la prima raportare, dar suma ramane protejata
// prin incadrarea intr-un interval de 50 lei.
export function statisticiPublice(raportari, tip, arhiva = []) {
  const grupuri = new Map();
  for (const r of raportari.filter((r) => r.tip === tip)) {
    const cheie = `${r.localitate}__${r.perioada}`;
    if (!grupuri.has(cheie)) grupuri.set(cheie, { localitate: r.localitate, perioada: r.perioada, intervale: [] });
    grupuri.get(cheie).intervale.push({ interval: bucketSuma(r.suma), numar: 1 });
  }
  for (const r of arhiva.filter((r) => r.tip === tip)) {
    const cheie = `${r.localitate}__${r.perioada}`;
    if (!grupuri.has(cheie)) grupuri.set(cheie, { localitate: r.localitate, perioada: r.perioada, intervale: [] });
    grupuri.get(cheie).intervale.push({ interval: r.suma_interval, numar: r.numar_raportari });
  }
  return [...grupuri.values()]
    .map((g) => {
      const intervale = g.intervale.sort((a, b) => Number(a.interval.split('-')[0]) - Number(b.interval.split('-')[0]));
      const numarRaspunsuri = intervale.reduce((acc, r) => acc + r.numar, 0);
      const pozitieMediana = Math.floor(numarRaspunsuri / 2);
      let cumulative = 0;
      const mediana = intervale.find((r) => (cumulative += r.numar) > pozitieMediana)?.interval;
      return {
        localitate: g.localitate,
        perioada: g.perioada,
        numarRaspunsuri,
        sumaMedianaInterval: mediana,
        sumaMinInterval: intervale[0].interval,
        sumaMaxInterval: intervale[intervale.length - 1].interval,
      };
    });
}
