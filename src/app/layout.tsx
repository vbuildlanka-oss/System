import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VBUILD | Buyer Price List Generator",
  description:
    "Upload an order PDF, apply a per-bag markup, and download a buyer-ready price list. By VBUILD.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
