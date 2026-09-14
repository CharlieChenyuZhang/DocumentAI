import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Document AI | A little more understanding",
  description:
    "A thoughtful workspace for your documents. Ask questions, explore ideas, and connect document knowledge with the web.",
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
