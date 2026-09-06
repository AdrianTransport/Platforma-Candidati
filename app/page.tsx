import Link from "next/link";
import {
  ArrowRight,
  CalendarPlus,
  Check,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  FilePenLine,
  MapPin,
  Plus,
  Radio,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { candidate, channels, complianceItems, upcoming } from "@/lib/demo-data";

export default function DashboardPage() {
  return (
    <main className="app-shell">
      <Sidebar />
      <section className="main-area">
        <header className="topbar">
          <button className="mobile-menu" aria-label="Deschide meniul">☰</button>
          <div className="deadline"><span className="live-dot" />Campanie activă · {candidate.daysLeft} zile rămase</div>
          <div className="top-actions">
            <Link className="button ghost" href={`/c/andrei-popescu`}><ExternalLink size={17} />Vezi site-ul public</Link>
            <button className="avatar">AP</button>
          </div>
        </header>

        <div className="content">
          <div className="welcome-row">
            <div>
              <p className="eyebrow">CENTRUL CAMPANIEI</p>
              <h1>Bun venit, Andrei.</h1>
              <p>Ai controlul mesajului, calendarului și transparenței într-un singur loc.</p>
            </div>
            <button className="button primary"><Plus size={18} />Creează o postare</button>
          </div>

          <section className="command-card">
            <div className="command-copy">
              <span className="command-icon"><Sparkles size={21} /></span>
              <div>
                <p className="eyebrow light">URMĂTORUL PAS RECOMANDAT</p>
                <h2>Finalizează politica de campanie</h2>
                <p>Mai ai un document de confirmat înainte ca toate instrumentele să fie disponibile.</p>
              </div>
            </div>
            <button className="button white">Continuă configurarea <ArrowRight size={17} /></button>
          </section>

          <div className="stats-grid">
            <article className="stat-card"><span>Audiență totală</span><strong>83,9K</strong><small className="positive">+12,4% în ultimele 30 zile</small></article>
            <article className="stat-card"><span>Conținut publicat</span><strong>36</strong><small>pe 3 canale conectate</small></article>
            <article className="stat-card"><span>Susținători înscriși</span><strong>1.284</strong><small className="positive">+89 săptămâna aceasta</small></article>
            <article className="stat-card"><span>Acțiuni de conformitate</span><strong>3/4</strong><small className="warning">1 element necesită atenție</small></article>
          </div>

          <div className="dashboard-grid">
            <section className="panel channels-panel">
              <div className="panel-head"><div><p className="eyebrow">CANalele TALE</p><h2>Prezență digitală</h2></div><button className="text-button">Administrează <ChevronRight size={16} /></button></div>
              <div className="channels-list">
                {channels.map((channel) => (
                  <div className="channel-row" key={channel.name}>
                    <span className={`channel-logo ${channel.tone}`}>{channel.name[0]}</span>
                    <div className="channel-name"><strong>{channel.name}</strong><small>{channel.posts} postări</small></div>
                    <span className={channel.status === "Conectat" ? "status connected" : "status pending"}>{channel.status}</span>
                    <div className="reach"><strong>{channel.reach}</strong><small>audiență</small></div>
                    <button className="icon-button" aria-label={`Deschide ${channel.name}`}><ChevronRight size={18} /></button>
                  </div>
                ))}
              </div>
              <div className="platform-policy"><CircleAlert size={18} /><p><strong>Promovarea politică plătită este restricționată în UE.</strong> Civis folosește aceste canale pentru publicare organică și analiză, în limitele fiecărei platforme.</p></div>
            </section>

            <section className="panel compliance-panel">
              <div className="panel-head"><div><p className="eyebrow">SIGURANȚĂ ȘI LEGALITATE</p><h2>Conformitatea campaniei</h2></div><span className="score-ring">75%</span></div>
              <div className="compliance-list">
                {complianceItems.map((item) => (
                  <div className="check-row" key={item.label}>
                    <span className={item.done ? "check done" : "check attention"}>{item.done ? <Check size={15} /> : "!"}</span>
                    <span><strong>{item.label}</strong><small>{item.state}</small></span>
                  </div>
                ))}
              </div>
              <button className="button outline full"><ShieldCheck size={17} />Deschide centrul de conformitate</button>
            </section>
          </div>

          <div className="dashboard-grid lower">
            <section className="panel">
              <div className="panel-head"><div><p className="eyebrow">URMEAZĂ</p><h2>Calendarul campaniei</h2></div><button className="icon-button"><CalendarPlus size={19} /></button></div>
              <div className="event-list">
                {upcoming.map((event) => <div className="event-row" key={event.title}><span className="date-block"><strong>{event.day}</strong><small>{event.month}</small></span><span><strong>{event.title}</strong><small>{event.meta}</small></span></div>)}
              </div>
            </section>
            <section className="panel website-panel">
              <div className="site-status"><span><Radio size={17} />PUBLICAT</span><small>Actualizat acum 2 ore</small></div>
              <h2>Site-ul tău este online</h2>
              <p>andrei-popescu.civis.ro</p>
              <div className="site-actions"><Link className="button outline" href="/c/andrei-popescu"><ExternalLink size={17} />Deschide</Link><button className="button primary"><FilePenLine size={17} />Editează site-ul</button></div>
            </section>
          </div>

          <footer className="dashboard-footer"><span><MapPin size={16} />Zonă principală: {candidate.region}</span><span>Toate acțiunile sunt înregistrate în jurnalul campaniei.</span></footer>
        </div>
      </section>
    </main>
  );
}
