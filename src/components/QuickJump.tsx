"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Boxes,
  ClipboardCheck,
  ClipboardList,
  CornerDownLeft,
  ListChecks,
  Search,
  Users,
  X,
} from "lucide-react";
import { loadStockpile, itemBags } from "@/lib/stockpile";
import { loadCountDoc } from "@/lib/counter";
import { loadRequests, outstanding } from "@/lib/buyerRequest";
import { loadManifests } from "@/lib/bagManifest";
import { loadPayrollDoc, monthsNewestFirst } from "@/lib/payroll";
import { bestRank } from "@/lib/search";
import { FIND_EVENT, type FindDetail } from "@/lib/useFind";
import { cn } from "@/lib/cn";

/**
 * Press "/" anywhere - or Ctrl+K, or the search button in the bar - and type.
 *
 * On a warehouse floor the question is rarely "which page" but "where is the
 * Anorak": how many bags are in stock, has it been counted, who is waiting for
 * it. So this searches the pages and everything saved on this device at once,
 * and Enter goes straight to the right page with the search already filled in.
 *
 * It only reads what is stored in this browser - nothing is sent anywhere - and
 * shows no money. Pay in particular stays on the payroll page: a person found
 * here is a name and a link, never a salary.
 */

export interface JumpPage {
  href: string;
  label: string;
  hint: string;
  group: string;
}

interface Result {
  id: string;
  kind: "page" | "stock" | "count" | "request" | "manifest" | "person";
  title: string;
  detail: string;
  href: string;
  /** What to search for on arrival, if anything. */
  q: string;
  rank: number;
}

const KIND_ICON = {
  page: ArrowRight,
  stock: Boxes,
  count: ClipboardCheck,
  request: ListChecks,
  manifest: ClipboardList,
  person: Users,
} as const;

/** Bags and names only: enough to answer "where is it", nothing to leak. */
export function gather(query: string, pages: JumpPage[]): Result[] {
  const out: Result[] = [];
  const push = (r: Omit<Result, "rank">, ...fields: string[]) => {
    const rank = bestRank(query, ...fields);
    if (rank !== null) out.push({ ...r, rank });
  };

  for (const page of pages) {
    push(
      {
        id: `page:${page.href}`,
        kind: "page",
        title: page.label,
        detail: `${page.group} · ${page.hint}`,
        href: page.href,
        q: "",
      },
      page.label,
      page.hint,
      page.group,
    );
  }
  // An empty query lists the pages, which makes the box a menu too.
  if (query.trim() === "") return out.map((r) => ({ ...r, rank: 0 }));

  const stock = loadStockpile();
  for (const item of stock.items) {
    const bags = itemBags(item);
    push(
      {
        id: `stock:${item.id}`,
        kind: "stock",
        title: item.name,
        detail: bags > 0 ? `${bags} bag${bags === 1 ? "" : "s"} in the stockpile` : "In the stockpile, none left",
        href: "/stockpile",
        q: item.name,
      },
      item.name,
    );
  }

  const count = loadCountDoc();
  for (const row of count.rows) {
    push(
      {
        id: `count:${row.id}`,
        kind: "count",
        title: row.name,
        detail: row.touched
          ? `Counted ${row.counted}${row.added ? "" : ` of ${row.expected}`}${count.containerId ? ` · ${count.containerId}` : ""}`
          : `Not counted yet${row.expected ? ` · ${row.expected} expected` : ""}`,
        href: "/counter",
        q: row.name,
      },
      row.name,
    );
  }

  const requests = loadRequests();
  for (const request of requests.requests) {
    const waiting = request.items.reduce((n, i) => n + outstanding(i), 0);
    push(
      {
        id: `buyer:${request.id}`,
        kind: "request",
        title: request.buyer.name || "Unnamed buyer",
        detail: `${request.items.length} line${request.items.length === 1 ? "" : "s"} · ${waiting} bag${waiting === 1 ? "" : "s"} still to go`,
        href: "/requests",
        q: "",
      },
      request.buyer.name,
      request.buyer.phone,
    );
    for (const item of request.items) {
      const left = outstanding(item);
      if (left <= 0) continue;
      push(
        {
          id: `req:${request.id}:${item.id}`,
          kind: "request",
          title: item.name,
          detail: `${request.buyer.name || "A buyer"} is waiting for ${left}`,
          href: "/requests",
          q: item.name,
        },
        item.name,
      );
    }
  }

  const manifests = loadManifests();
  for (const manifest of manifests.manifests) {
    push(
      {
        id: `man:${manifest.id}`,
        kind: "manifest",
        title: manifest.orderNumber,
        detail: `Bag manifest${manifest.containerNumber ? ` · ${manifest.containerNumber}` : ""} · ${manifest.items.length} items`,
        href: "/bag-manifests",
        q: "",
      },
      manifest.orderNumber,
      manifest.containerNumber,
    );
  }

  const payroll = loadPayrollDoc();
  const latest = monthsNewestFirst(payroll)[0];
  if (latest) {
    for (const row of latest.rows) {
      if (row.name === "") continue;
      push(
        {
          id: `person:${row.id}`,
          kind: "person",
          title: row.name,
          detail: row.position ? `On the payroll · ${row.position}` : "On the payroll",
          href: "/payroll",
          q: row.name,
        },
        row.name,
        row.position,
        row.tin,
      );
    }
  }

  // Best answers first; among equals, pages before records.
  return out.sort(
    (a, b) => a.rank - b.rank || Number(b.kind === "page") - Number(a.kind === "page"),
  );
}

export default function QuickJump({ pages }: { pages: JumpPage[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // "/" and Ctrl+K open it from anywhere, except while typing in a field, where
  // a slash is a slash.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      const wantsIt =
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") ||
        (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey);
      if (wantsIt) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    const onOpen = () => setOpen(true);
    window.addEventListener("balebook:quickjump", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("balebook:quickjump", onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // After the dialog renders.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const results = useMemo(
    () => (open ? gather(query, pages).slice(0, 30) : []),
    [open, query, pages],
  );

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const go = useCallback(
    (result: Result | undefined) => {
      if (!result) return;
      setOpen(false);
      const here = window.location.pathname === result.href;
      if (here) {
        // Same page: no navigation happens, so the page is told directly.
        window.dispatchEvent(
          new CustomEvent<FindDetail>(FIND_EVENT, {
            detail: { href: result.href, q: result.q },
          }),
        );
        return;
      }
      router.push(
        result.q ? `${result.href}?q=${encodeURIComponent(result.q)}` : result.href,
      );
    },
    [router],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-gray-900/40 px-3 pt-[10vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Quick jump"
    >
      <div className="w-full max-w-xl animate-fade-in overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl">
        <div className="flex items-center gap-2 border-b border-gray-100 px-4">
          <Search className="h-5 w-5 shrink-0 text-gray-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                go(results[active]);
              }
            }}
            placeholder="Search pages, stock, counts, buyers, people…"
            className="w-full py-4 text-base outline-none placeholder:text-gray-400"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <ul ref={listRef} className="max-h-[60vh] overflow-y-auto p-1.5">
          {results.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-gray-500">
              Nothing saved on this device matches &ldquo;{query.trim()}&rdquo;.
            </li>
          )}
          {results.map((result, i) => {
            const Icon = KIND_ICON[result.kind];
            return (
              <li key={result.id}>
                <button
                  data-index={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(result)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition",
                    i === active ? "bg-brand-50" : "hover:bg-gray-50",
                  )}
                >
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0",
                      i === active ? "text-brand-600" : "text-gray-400",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-gray-900">
                      {result.title}
                    </span>
                    <span className="block truncate text-xs text-gray-500">
                      {result.detail}
                    </span>
                  </span>
                  {i === active && (
                    <CornerDownLeft className="h-4 w-4 shrink-0 text-brand-400" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center justify-between border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
          <span>↑ ↓ to choose · Enter to go · Esc to close</span>
          <span>Press / anywhere</span>
        </div>
      </div>
    </div>
  );
}
