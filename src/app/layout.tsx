import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Document AI | Chat with your documents",
  description:
    "Upload a PDF, ask questions, and read document and web answers in one simple workspace.",
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
