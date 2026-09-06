import Link from "next/link";
import {
  BarChart3,
  CalendarDays,
  FileCheck2,
  Globe2,
  LayoutDashboard,
  Megaphone,
  Settings,
  UsersRound,
} from "lucide-react";

const items = [
  [LayoutDashboard, "Privire de ansamblu", true],
  [Megaphone, "Conținut și publicare", false],
  [CalendarDays, "Calendar", false],
  [Globe2, "Site-ul candidatului", false],
  [UsersRound, "Susținători", false],
  [BarChart3, "Rezultate", false],
  [FileCheck2, "Conformitate", false],
] as const;

export function Sidebar() {
  return (
    <aside className="sidebar">
      <Link className="brand" href="/" aria-label="Civis, pagina principală">
        <span className="brand-mark">C</span>
        <span>Civis</span>
      </Link>
      <div className="workspace-label">CAMPANIE ACTIVĂ</div>
      <button className="campaign-switcher">
        <span className="avatar avatar-small">AP</span>
        <span><strong>Andrei Popescu</strong><small>Locale 2028</small></span>
        <span aria-hidden="true">⌄</span>
      </button>
      <nav aria-label="Navigare principală">
        {items.map(([Icon, label, active]) => (
          <Link className={active ? "nav-item active" : "nav-item"} href="#" key={label}>
            <Icon size={19} strokeWidth={1.8} />
            <span>{label}</span>
          </Link>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <Link className="nav-item" href="#"><Settings size={19} />Setări</Link>
        <div className="legal-note"><FileCheck2 size={18} /><span><strong>Mod conform activ</strong><small>Jurnalul de transparență funcționează</small></span></div>
      </div>
    </aside>
  );
}
