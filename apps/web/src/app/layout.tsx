import { brand } from "@duckzap/brand";
import { themeInitScript } from "@duckzap/ui/theme";
import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { headers } from "next/headers";
import Script from "next/script";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import type { ReactNode } from "react";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-jakarta",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: brand.name, template: `%s · ${brand.name}` },
  description: brand.description,
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F6F7F4" },
    { media: "(prefers-color-scheme: dark)", color: "#0B151D" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    // o script de tema pode definir data-theme antes da hidratação
    <html lang="pt-BR" className={jakarta.variable} suppressHydrationWarning>
      <body className="antialiased">
        {/* aplica o tema salvo antes da pintura (sem piscar); <script> solto em componente gera aviso no React 19 */}
        <Script id="theme-init" nonce={nonce} strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <NuqsAdapter>{children}</NuqsAdapter>
      </body>
    </html>
  );
}
