"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Boxes,
  ClipboardList,
  FileSpreadsheet,
  ListChecks,
  PencilRuler,
} from "lucide-react";
import { cn } from "@/lib/cn";

const links = [
  { href: "/", label: "Price List", icon: FileSpreadsheet },
  { href: "/edit", label: "Order Editor", icon: PencilRuler },
  { href: "/bag-manifests", label: "Bag Manifests", icon: ClipboardList },
  { href: "/stockpile", label: "Stockpile", icon: Boxes },
  { href: "/requests", label: "Requests", icon: ListChecks },
];

export default function Nav() {
  const pathname = usePathname();
  return (
    <nav className="sticky top-0 z-30 border-b border-gray-200/80 bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link
          href="/"
          className="text-xl font-bold tracking-tight text-brand-600 sm:text-2xl"
        >
          BaleBook
        </Link>
        <div className="flex items-center gap-1">
          {links.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition",
                  active
                    ? "bg-brand-50 text-brand-700"
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="hidden sm:inline">{label}</span>
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
