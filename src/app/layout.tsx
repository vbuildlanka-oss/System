import type { Metadata } from "next";
import "./globals.css";
import Nav from "@/components/Nav";

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
      <body>
        <Nav />
        {children}
      </body>
    </html>
  );
}
