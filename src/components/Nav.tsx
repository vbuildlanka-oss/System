"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Boxes,
  Calculator,
  ChevronDown,
  ClipboardCheck,
  ClipboardList,
  Database,
  FileSpreadsheet,
  ListChecks,
  Menu,
  PencilRuler,
  Scale,
  Wallet,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The top bar.
 *
 * Nine pages in one flat row had stopped being a menu and become a wall: on a
 * laptop the labels ran out of room, and on a phone it was nine unlabelled icons
 * in a line, which is a guessing game. So the pages are gathered into the three
 * things this business actually does - price the goods, run the warehouse, keep
 * the accounts - and each group opens on click.
 *
 * Click rather than hover, because half of this is used on a phone where there is
 * no hover, and a menu that only works with a mouse is a menu that does not work
 * in the warehouse.
 *
 * Nothing is hidden behind a group without also being reachable: the phone panel
 * lists every page under its heading, and the current page's group stays lit so
 * you can always see where you are.
 */

interface NavItem {
  href: string;
  label: string;
  icon: typeof Boxes;
  /** One line on the dropdown, so a name like "Calculation" is not a riddle. */
  hint: string;
}

interface NavGroup {
  id: string;
  label: string;
  icon: typeof Boxes;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "pricing",
    label: "Pricing",
    icon: FileSpreadsheet,
    items: [
      {
        href: "/",
        label: "Price List",
        icon: FileSpreadsheet,
        hint: "Turn an order into the buyer's price list",
      },
      {
        href: "/calculation",
        label: "Calculation",
        icon: Calculator,
        hint: "Work out the markup, item by item",
      },
      {
        href: "/edit",
        label: "Order Editor",
        icon: PencilRuler,
        hint: "Keep a sheet live as bags sell",
      },
    ],
  },
  {
    id: "warehouse",
    label: "Warehouse",
    icon: Boxes,
    items: [
      {
        href: "/counter",
        label: "Counter",
        icon: ClipboardCheck,
        hint: "Count the bags on the floor",
      },
      {
        href: "/stockpile",
        label: "Stockpile",
        icon: Boxes,
        hint: "What is in stock, and how long it has been",
      },
      {
        href: "/bag-manifests",
        label: "Bag Manifests",
        icon: ClipboardList,
        hint: "What went into which container",
      },
      {
        href: "/requests",
        label: "Requests",
        icon: ListChecks,
        hint: "What buyers have asked for",
      },
    ],
  },
  {
    id: "accounts",
    label: "Accounts",
    icon: Scale,
    items: [
      {
        href: "/balance",
        label: "Balance Sheet",
        icon: Scale,
        hint: "Expenses, turnover and what is owed",
      },
      {
        href: "/payroll",
        label: "Payroll",
        icon: Wallet,
        hint: "Wages, EPF and ETF, month by month",
      },
    ],
  },
];

/** Every page in the bar, flattened - used to name the current one. */
const ALL_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

export default function Nav() {
  const pathname = usePathname();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  // Arriving somewhere new closes whatever was open, or the menu would still be
  // hanging over the page you just chose.
  useEffect(() => {
    setOpenGroup(null);
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (openGroup === null && !menuOpen) return;

    const onPointer = (event: MouseEvent | TouchEvent) => {
      if (!barRef.current?.contains(event.target as Node)) {
        setOpenGroup(null);
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenGroup(null);
        setMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [openGroup, menuOpen]);

  const current = ALL_ITEMS.find((item) => item.href === pathname);
  const dataActive = pathname === "/data";

  return (
    <nav className="sticky top-0 z-30 border-b border-gray-200/80 bg-white/80 backdrop-blur">
      <div
        ref={barRef}
        className="mx-auto max-w-6xl px-4"
      >
        <div className="flex items-center justify-between py-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <Link
              href="/"
              className="text-xl font-bold tracking-tight text-brand-600 sm:text-2xl"
            >
              BaleBook
            </Link>
            {/* On a phone the groups collapse, so the page name is the only
                thing telling you where you are. */}
            {current && (
              <span className="truncate text-sm text-gray-400 md:hidden">
                {current.label}
              </span>
            )}
          </div>

          {/* ------------------------------ desktop ------------------------------ */}
          <div className="hidden items-center gap-1 md:flex">
            {NAV_GROUPS.map((group) => {
              const Icon = group.icon;
              const holdsCurrent = group.items.some(
                (item) => item.href === pathname,
              );
              const open = openGroup === group.id;
              return (
                <div key={group.id} className="relative">
                  <button
                    type="button"
                    onClick={() => setOpenGroup(open ? null : group.id)}
                    aria-expanded={open}
                    aria-haspopup="true"
                    className={cn(
                      "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition",
                      holdsCurrent
                        ? "bg-brand-50 text-brand-700"
                        : open
                          ? "bg-gray-100 text-gray-900"
                          : "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {group.label}
                    <ChevronDown
                      className={cn(
                        "h-3.5 w-3.5 transition-transform",
                        open && "rotate-180",
                      )}
                    />
                  </button>

                  {open && (
                    <div className="absolute right-0 z-40 mt-1 w-72 animate-fade-in overflow-hidden rounded-xl border border-gray-200 bg-white p-1.5 shadow-lg">
                      {group.items.map((item) => {
                        const ItemIcon = item.icon;
                        const active = pathname === item.href;
                        return (
                          <Link
                            key={item.href}
                            href={item.href}
                            className={cn(
                              "flex items-start gap-3 rounded-lg px-3 py-2.5 transition",
                              active
                                ? "bg-brand-50"
                                : "hover:bg-gray-50",
                            )}
                          >
                            <ItemIcon
                              className={cn(
                                "mt-0.5 h-4 w-4 shrink-0",
                                active ? "text-brand-600" : "text-gray-400",
                              )}
                            />
                            <span className="min-w-0">
                              <span
                                className={cn(
                                  "block text-sm font-medium",
                                  active ? "text-brand-700" : "text-gray-800",
                                )}
                              >
                                {item.label}
                              </span>
                              <span className="block text-xs text-gray-500">
                                {item.hint}
                              </span>
                            </span>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

            <span className="mx-1 h-5 w-px bg-gray-200" aria-hidden />
            <Link
              href="/data"
              title="See and delete the data saved in this browser"
              className={cn(
                "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition",
                dataActive
                  ? "bg-red-50 text-red-700"
                  : "text-gray-500 hover:bg-red-50 hover:text-red-700",
              )}
            >
              <Database className="h-4 w-4" />
              <span className="hidden lg:inline">Saved data</span>
            </Link>
          </div>

          {/* ------------------------------- phone ------------------------------- */}
          <button
            type="button"
            onClick={() => setMenuOpen((was) => !was)}
            aria-expanded={menuOpen}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-100 md:hidden"
          >
            {menuOpen ? (
              <X className="h-5 w-5" />
            ) : (
              <Menu className="h-5 w-5" />
            )}
          </button>
        </div>

        {/* Everything, under its heading. No dropdowns on a phone: a tap that
            opens a menu to reveal another menu is a tap wasted. */}
        {menuOpen && (
          <div className="animate-fade-in border-t border-gray-100 pb-3 md:hidden">
            {NAV_GROUPS.map((group) => (
              <div key={group.id} className="pt-3">
                <p className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
                  {group.label}
                </p>
                <div className="grid grid-cols-2 gap-1">
                  {group.items.map((item) => {
                    const ItemIcon = item.icon;
                    const active = pathname === item.href;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={cn(
                          "inline-flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition",
                          active
                            ? "bg-brand-50 text-brand-700"
                            : "text-gray-600 hover:bg-gray-100",
                        )}
                      >
                        <ItemIcon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="mt-3 border-t border-gray-100 pt-3">
              <Link
                href="/data"
                className={cn(
                  "inline-flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition",
                  dataActive
                    ? "bg-red-50 text-red-700"
                    : "text-gray-500 hover:bg-red-50 hover:text-red-700",
                )}
              >
                <Database className="h-4 w-4" />
                Saved data
              </Link>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
