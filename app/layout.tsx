import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Civis — Centrul campaniei tale",
  description: "Platformă pentru administrarea transparentă a campaniilor electorale.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ro">
      <body>{children}</body>
    </html>
  );
}
