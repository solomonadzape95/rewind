import type { Metadata } from "next";
import { JetBrains_Mono, Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const sans = Inter({ variable: "--font-sans", subsets: ["latin"] });
const mono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Rewind",
  description: "Time-travel memory for production agents",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${sans.variable} ${mono.variable}`}>
        <div className="grid-bg pointer-events-none fixed inset-0 -z-10" />
        <div className="mx-auto max-w-6xl px-6 pb-32 pt-10 sm:px-10">
          <header className="mb-10 flex flex-col gap-6 border-b border-line pb-8 sm:mb-14 sm:flex-row sm:items-end sm:justify-between">
            <Link href="/" className="flex items-center gap-5">
              <div className="stripe-dense flex h-14 w-14 shrink-0 items-center justify-center border border-line-strong sm:h-16 sm:w-16">
                <span className="font-mono text-xl sm:text-2xl">R</span>
              </div>
              <div>
                <h1 className="text-[clamp(1.5rem,3vw,2.25rem)] font-medium leading-none tracking-tight">
                  Rewind
                </h1>
                <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.28em] text-faint sm:text-[12px]">
                  Agent memory forensics
                </p>
              </div>
            </Link>

            <p className="max-w-sm font-mono text-[11px] leading-relaxed tracking-[0.08em] text-faint">
              No audit table. No event log. No snapshots. MVCC and one SQL clause.
            </p>
          </header>

          {children}
        </div>
      </body>
    </html>
  );
}
