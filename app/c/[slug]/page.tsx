import Link from "next/link";
import { ArrowRight, CalendarDays, CheckCircle2, MapPin, Menu } from "lucide-react";

export default async function CandidateSite({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <main className="public-site">
      <header className="public-header">
        <Link href={`/c/${slug}`} className="candidate-logo"><span>AP</span><strong>Andrei Popescu</strong></Link>
        <nav><a href="#prioritati">Priorități</a><a href="#despre">Despre mine</a><a href="#agenda">Agenda</a><a href="#contact">Implică-te</a></nav>
        <button className="public-menu" aria-label="Deschide meniul"><Menu /></button>
      </header>
      <section className="public-hero">
        <div className="hero-copy">
          <span className="candidate-kicker"><MapPin size={16} />Pentru Timișoara</span>
          <h1>Un oraș care lucrează <em>pentru oameni.</em></h1>
          <p>Administrație deschisă, cartiere îngrijite și decizii luate împreună cu timișorenii.</p>
          <div className="hero-actions"><a className="button public-primary" href="#prioritati">Vezi programul <ArrowRight size={18} /></a><a className="button public-secondary" href="#contact">Alătură-te echipei</a></div>
          <small className="transparency"><CheckCircle2 size={15} />Pagină oficială verificată · Publicată transparent prin Civis</small>
        </div>
        <div className="portrait-card" aria-label="Spațiu rezervat fotografiei oficiale a candidatului">
          <div className="portrait-initials">AP</div>
          <span>Fotografia oficială a candidatului</span>
        </div>
      </section>
      <section className="priorities" id="prioritati">
        <div className="section-title"><span>PROGRAM LOCAL</span><h2>Trei priorități concrete</h2><p>Planuri măsurabile, termene publice și raportare transparentă.</p></div>
        <div className="priority-grid">
          <article><span>01</span><h3>Transport care respectă timpul oamenilor</h3><p>Benzi dedicate, conexiuni mai bune între cartiere și informații în timp real.</p><a href="#">Citește planul <ArrowRight size={16} /></a></article>
          <article><span>02</span><h3>Cartiere curate și sigure</h3><p>Iluminat modern, întreținere predictibilă și sesizări rezolvate transparent.</p><a href="#">Citește planul <ArrowRight size={16} /></a></article>
          <article><span>03</span><h3>Primărie simplă, fără cozi</h3><p>Servicii digitale clare, termene urmărite și răspunsuri pe înțelesul tuturor.</p><a href="#">Citește planul <ArrowRight size={16} /></a></article>
        </div>
      </section>
      <section className="public-event" id="agenda"><CalendarDays size={28} /><div><span>URMĂTORUL EVENIMENT</span><h2>Întâlnire cu locuitorii din Fabric</h2><p>9 septembrie, ora 18:00 · Piața Traian</p></div><button className="button public-secondary">Vezi agenda</button></section>
      <footer className="public-footer"><div><strong>Andrei Popescu</strong><p>Candidat pentru Primăria Municipiului Timișoara</p></div><div className="disclosure"><strong>Transparență electorală</strong><p>Material publicat de echipa candidatului. Responsabilitatea conținutului aparține sponsorului declarat.</p></div></footer>
    </main>
  );
}
