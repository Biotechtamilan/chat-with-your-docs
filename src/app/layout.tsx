import type { Metadata } from "next";
import { Instrument_Sans, Literata } from "next/font/google";
import "./globals.css";

// Literata was drawn for long-form reading on screens, which is what answers and passages are.
const literata = Literata({ variable: "--font-literata", subsets: ["latin"], display: "swap" });
const instrument = Instrument_Sans({ variable: "--font-instrument", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "Marginalia: chat with your documents",
  description: "Ask questions about your documents and see the passages behind every answer.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Browser extensions (grammar checkers, dark-mode tools) add attributes to <html>
    // before React loads. Without this, each one shows up as a hydration warning.
    <html lang="en" className={`${literata.variable} ${instrument.variable}`} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
