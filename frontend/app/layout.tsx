import type { Metadata } from "next";
import PrivyClientProvider from "@/components/PrivyClientProvider";
import Header from "@/components/Header";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ramp402 — Pay-per-call Payment Gateway",
  description: "Pay-per-call micropayment gateway for APIs with instant local off-ramp",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-neutral-50 text-neutral-900 font-sans">
        <PrivyClientProvider>
          <Header />
          <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
            {children}
          </main>
        </PrivyClientProvider>
      </body>
    </html>
  );
}
