export const candidate = {
  name: "Andrei Popescu",
  office: "Candidat pentru Primăria Municipiului Timișoara",
  initials: "AP",
  campaign: "Timișoara pentru oameni",
  region: "Timișoara, județul Timiș",
  daysLeft: 47,
};

export const channels = [
  { name: "Facebook", status: "Conectat", posts: 18, reach: "42,8K", tone: "blue" },
  { name: "Instagram", status: "Conectat", posts: 12, reach: "31,4K", tone: "pink" },
  { name: "TikTok", status: "De conectat", posts: 0, reach: "—", tone: "black" },
  { name: "YouTube", status: "Conectat", posts: 6, reach: "9,7K", tone: "red" },
] as const;

export const complianceItems = [
  { label: "Identitatea candidatului", state: "Verificat", done: true },
  { label: "Operator și responsabil GDPR", state: "Completat", done: true },
  { label: "Date sponsor și plătitor", state: "Completat", done: true },
  { label: "Politici și contract semnate", state: "Necesită atenție", done: false },
] as const;

export const upcoming = [
  { day: "09", month: "SEP", title: "Întâlnire cu locuitorii din Fabric", meta: "18:00 · Piața Traian" },
  { day: "12", month: "SEP", title: "Publicare: planul pentru transport", meta: "10:30 · Toate canalele" },
  { day: "14", month: "SEP", title: "Dezbatere publică", meta: "19:00 · Sala Capitol" },
] as const;
