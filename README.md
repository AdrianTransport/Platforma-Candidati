# Platforma Candidați — Civis

Fundația unei platforme multi-candidat pentru site-uri electorale, conținut organic, organizarea campaniei și conformitate.

## Ce include prima versiune

- panou central de campanie, responsive;
- site public individual pe ruta `/c/[slug]`;
- model PostgreSQL/Supabase multi-organizație cu RLS;
- structură pentru conținut, conexiuni sociale, consimțăminte și audit;
- configurare de build pentru Netlify;
- avertizare clară privind restricțiile reclamelor politice în UE.

Datele afișate momentan sunt demonstrative. Conectarea Supabase, Stripe și OAuth se face după configurarea proiectelor externe și a variabilelor din `.env.example`.

## Pornire locală

```bash
npm install
npm run dev
```

## Verificări

```bash
npm run typecheck
npm run build
```

## Principii de conformitate

- fără profilare pe baza opiniilor politice sau a altor categorii speciale de date;
- consimțământ explicit, separat și versionat pentru susținători;
- separare strictă a datelor între campanii;
- jurnal de audit pentru acțiunile importante;
- tokenurile OAuth nu se păstrează în clar în tabelele aplicației;
- conținutul politic plătit este dezactivat pentru platformele care îl interzic în UE.

Textele juridice finale și fluxurile financiare trebuie validate de un avocat și de un expert în finanțarea campaniilor electorale înainte de lansarea comercială.
