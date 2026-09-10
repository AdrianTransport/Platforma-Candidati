import { textField, ValidationError } from './publication.js';

export const RETENTION_DAYS = 90;
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

// Sterge efectiv (nu doar ascunde) raportarile mai vechi de termenul de
// retentie - conformitatea GDPR ceruta cere stergere reala, nu doar o
// promisiune in text. Returneaza true daca a sters ceva (candidat pentru
// db.write() de catre apelant).
export function purjeazaRaportariExpirate(db, now = Date.now()) {
  const inainte = db.data.raportari_costuri.length;
  db.data.raportari_costuri = db.data.raportari_costuri.filter((r) => !esteExpirata(r, now));
  return db.data.raportari_costuri.length !== inainte;
}

export function raportareInput(body, tip) {
  if (!['apa', 'salubritate'].includes(tip)) throw new ValidationError('Tip de raportare invalid.');
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

// Suma totala raportata pentru un tip (apa/salubritate), afisata public.
// Aplicam acelasi prag minim de raspunsuri ca la statisticile pe grup, ca sa
// nu devina posibila identificarea unei persoane cand sunt foarte putine
// raportari in total (ex: daca stii ca e un singur raspuns, suma totala
// exacta iti spune exact cat a platit acea persoana).
export function totalPublic(raportari, tip) {
  const ale_tipului = raportari.filter((r) => r.tip === tip);
  if (ale_tipului.length < MIN_RASPUNSURI_PUBLICE) return null;
  return {
    suma: ale_tipului.reduce((acc, r) => acc + r.suma, 0),
    numarRaspunsuri: ale_tipului.length,
  };
}
// Agrega raportarile pentru afisare publica - fara nume, fara sume exacte,
// si ascunde complet grupurile cu prea putine raspunsuri (protectie impotriva
// re-identificarii intr-o localitate mica).
export function statisticiPublice(raportari, tip) {
  const grupuri = new Map();
  for (const r of raportari.filter((r) => r.tip === tip)) {
    const cheie = `${r.localitate}__${r.perioada}`;
    if (!grupuri.has(cheie)) grupuri.set(cheie, { localitate: r.localitate, perioada: r.perioada, raspunsuri: [] });
    grupuri.get(cheie).raspunsuri.push(r);
  }
  return [...grupuri.values()]
    .filter((g) => g.raspunsuri.length >= MIN_RASPUNSURI_PUBLICE)
    .map((g) => {
      const sume = g.raspunsuri.map((r) => r.suma).sort((a, b) => a - b);
      const mediana = sume[Math.floor(sume.length / 2)];
      return {
        localitate: g.localitate,
        perioada: g.perioada,
        numarRaspunsuri: g.raspunsuri.length,
        sumaMedianaInterval: bucketSuma(mediana),
        sumaMinInterval: bucketSuma(sume[0]),
        sumaMaxInterval: bucketSuma(sume[sume.length - 1]),
      };
    });
}
