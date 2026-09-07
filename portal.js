import { editorialImageUrl } from './editorial.js';
import { textField, ValidationError } from './publication.js';

export const PORTAL_TYPES = new Set(['stire', 'campanie']);
export const PORTAL_STATUS = new Set(['ciorna', 'publicat']);

export function isPortalPublished(post) {
  return post?.status === 'publicat';
}

export function portalPublicationDate(post) {
  return post?.data_publicare || post?.updated_at || post?.created_at;
}

export function portalPostInput(body, previous = null, now = Date.now()) {
  const tip = textField(body.tip, 'Tip material', 20, true);
  const status = textField(body.status, 'Stare', 20, true);
  if (!PORTAL_TYPES.has(tip)) throw new ValidationError('Tipul materialului nu este valid.');
  if (!PORTAL_STATUS.has(status)) throw new ValidationError('Starea materialului nu este validă.');

  const candidateId = tip === 'campanie' ? Number(body.candidate_id) : null;
  if (tip === 'campanie' && (!Number.isSafeInteger(candidateId) || candidateId < 1)) {
    throw new ValidationError('Selectează candidatul pentru care publici campania.');
  }
  if (['publicat'].includes(status) && body.confirmare_responsabilitate !== 'on') {
    throw new ValidationError('Confirmă verificarea editorială și datele de transparență înainte de publicare.');
  }

  const timestamp = new Date(now).toISOString();
  const wasPublished = previous?.status === 'publicat';
  return {
    tip,
    status,
    candidate_id: candidateId,
    titlu: textField(body.titlu, 'Titlu', 200, true),
    rezumat: textField(body.rezumat, 'Rezumat', 400, true),
    continut: textField(body.continut, 'Conținut', 30000, true),
    categorie: textField(body.categorie || (tip === 'campanie' ? 'Campanie' : 'Actualitate'), 'Categorie', 60, true),
    finantator: textField(body.finantator, 'Finanțator', 200, tip === 'campanie'),
    imagine_url: editorialImageUrl(body.imagine_url),
    imagine_alt: textField(body.imagine_alt, 'Descriere imagine', 240),
    imagine_legenda: textField(body.imagine_legenda, 'Legendă imagine', 300),
    imagine_credit: textField(body.imagine_credit, 'Sursa imaginii', 160),
    imagine_generata_ai: body.imagine_generata_ai === 'true',
    generat_de_ai: body.generat_de_ai === 'true',
    principal: body.principal === 'on',
    updated_at: timestamp,
    data_publicare: status === 'publicat' ? (wasPublished ? previous.data_publicare : timestamp) : null,
  };
}
