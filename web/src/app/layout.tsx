import type { Metadata, Viewport } from "next";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { BRAND } from "@/lib/brand";
import { Footer, Header } from "@/components/Chrome";
import { Providers } from "./providers";
import "./globals.css";

const SITE =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : `https://${BRAND.domain}`);
const TITLE = `${BRAND.name}: swap, trade and earn on tokenized stocks`;
const DESCRIPTION =
  "Swap Robinhood Stock Tokens at the Chainlink price, trade perps up to 10x, provide liquidity to the Pool, earn option premiums and predict prices. On Robinhood Chain.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: TITLE, template: `%s · ${BRAND.name}` },
  description: DESCRIPTION,
  icons: { icon: "/icon.svg" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: "/", siteName: BRAND.name, images: [{ url: "/og.png", width: 1200, height: 630 }] },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"], ...(BRAND.xHandle ? { site: BRAND.xHandle } : {}) },
};

export const viewport: Viewport = { themeColor: "#0d1015" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="glow" aria-hidden="true" />
        <Providers>
          <Header />
          <main>{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
