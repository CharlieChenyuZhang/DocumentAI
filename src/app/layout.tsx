import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Document AI | Chat with your documents",
  description:
    "Search your private document library, compare PDFs, and get streamed answers with document and web sources.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
