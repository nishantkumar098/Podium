import "@podium/ui/src/tokens.css";
import "./globals.css";
import type { Metadata } from "next";
import { Cormorant_Garamond, IBM_Plex_Mono, IBM_Plex_Sans, Lora } from "next/font/google";
import type { ReactNode } from "react";
import { Providers } from "./providers";

// Self-hosted by next/font and preloaded with the page. The previous CSS
// @import of Google Fonts blocked the first paint on an extra round trip to
// fonts.googleapis.com before any text could render.
const ui = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--nf-ui", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--nf-mono", display: "swap" });
const display = Lora({ subsets: ["latin"], weight: ["500", "600"], style: ["normal", "italic"], variable: "--nf-display", display: "swap" });
/** The opening animation's wordmark face — the invoices' display serif. */
const intro = Cormorant_Garamond({ subsets: ["latin"], weight: ["300", "400"], variable: "--nf-intro", display: "swap" });

export const metadata: Metadata = {
  title: "Podium — AMM Brands LLP",
  description: "Podium v2 — production operating system for AMM Brands LLP",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${ui.variable} ${mono.variable} ${display.variable} ${intro.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
