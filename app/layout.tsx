/* ============================================================
   app/layout.tsx
   Typeface: Hanken Grotesk — a clean, modern, humanist sans.
   Trustworthy, accessible, calm; wide weight range (400–800)
   used for both body and display per the "Dawn / Horizon" design.
   Non-Latin scripts (Arabic, Amharic, Burmese, Farsi, Tigrinya,
   etc.) fall back to the Noto family declared in --font-sans /
   --font-display, which the browser picks per-glyph.
   ============================================================ */
import type { Metadata } from "next";
import { Hanken_Grotesk } from "next/font/google";
import "./globals.css";

const hanken = Hanken_Grotesk({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-hanken",
  weight: ["400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "Wayfinder — Find the Benefits You Qualify For",
  description:
    "Free, private help for immigrants and refugees to find U.S. government benefits and understand your next steps.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`h-full antialiased ${hanken.variable}`}>
      {/* body inherits --font-sans via globals.css; bg/text use design tokens */}
      <body className="min-h-full flex flex-col bg-background text-text">
        {children}
      </body>
    </html>
  );
}
