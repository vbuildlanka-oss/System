"use client";

import { useEffect, useMemo, useState } from "react";
import {
  User,
  Phone,
  CheckCircle2,
  AlertTriangle,
  MessageCircle,
  X,
  Hash,
  Clock,
  Trash2,
} from "lucide-react";
import {
  checkPhone,
  forgetBuyer,
  hasBuyerInfo,
  loadBuyers,
  whatsappLink,
  type Buyer,
} from "@/lib/buyer";
import { cn } from "@/lib/cn";

interface Props {
  value: Buyer;
  onChange: (buyer: Buyer) => void;
  /** Optional editable document reference (shown on the PDF). */
  refNo?: string;
  onRefChange?: (ref: string) => void;
  /** Bump this to re-read the saved buyer list. */
  refreshKey?: number;
  /** Compact mode hides the heading and reference field (used in dialogs). */
  compact?: boolean;
  heading?: string;
  description?: string;
}

export default function BuyerFields({
  value,
  onChange,
  refNo,
  onRefChange,
  refreshKey = 0,
  compact = false,
  heading = "Buyer details",
  description = "Printed on the PDF.",
}: Props) {
  const [saved, setSaved] = useState<Buyer[]>([]);
  const [showList, setShowList] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setSaved(loadBuyers());
  }, [refreshKey]);

  const phone = checkPhone(value.phone);
  const wa = whatsappLink(value.phone);

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? saved.filter(
          (b) =>
            b.name.toLowerCase().includes(q) ||
            b.phone.replace(/\D/g, "").includes(q.replace(/\D/g, "")),
        )
      : saved;
    return list.slice(0, 6);
  }, [saved, query]);

  const set = (patch: Partial<Buyer>) => onChange({ ...value, ...patch });

  return (
    <div
      className={cn(
        !compact &&
          "rounded-2xl border border-gray-200 bg-white p-5 shadow-sm",
      )}
    >
      {!compact && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 font-semibold text-gray-900">
              <User className="h-4 w-4 text-brand-600" />
              {heading}
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">{description}</p>
          </div>
          {hasBuyerInfo(value) && (
            <button
              type="button"
              onClick={() => onChange({ name: "", phone: "" })}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-50"
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </button>
          )}
        </div>
      )}

      <div className={cn("grid gap-3", !compact && "sm:grid-cols-2")}>
        {/* Name + saved-buyer autocomplete */}
        <div className="relative">
          <label className="mb-1 block text-xs font-medium text-gray-600">
            Buyer name
          </label>
          <div className="relative">
            <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              value={value.name}
              onChange={(e) => {
                set({ name: e.target.value });
                setQuery(e.target.value);
              }}
              onFocus={() => {
                setQuery(value.name);
                setShowList(true);
              }}
              onBlur={() => window.setTimeout(() => setShowList(false), 120)}
              placeholder="e.g. Ahmad Trading"
              autoComplete="off"
              className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </div>

          {showList && suggestions.length > 0 && (
            <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-auto rounded-xl border border-gray-200 bg-white py-1 shadow-lg">
              <li className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                <Clock className="h-3 w-3" />
                Recent buyers
              </li>
              {suggestions.map((b, i) => (
                <li key={`${b.name}-${b.phone}-${i}`}>
                  <div className="group flex items-center">
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        onChange({ name: b.name, phone: b.phone });
                        setShowList(false);
                      }}
                      className="flex-1 px-3 py-2 text-left text-sm transition hover:bg-brand-50"
                    >
                      <span className="block truncate font-medium text-gray-800">
                        {b.name || "(no name)"}
                      </span>
                      {b.phone && (
                        <span className="block truncate text-xs text-gray-500">
                          {checkPhone(b.phone).pretty}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      title="Remove from saved buyers"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setSaved(forgetBuyer(b));
                      }}
                      className="mr-2 rounded-md p-1.5 text-gray-300 opacity-0 transition hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Phone */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">
            Phone number
          </label>
          <div className="relative">
            <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              value={value.phone}
              onChange={(e) => set({ phone: e.target.value })}
              placeholder="077 123 4567"
              inputMode="tel"
              autoComplete="off"
              className={cn(
                "w-full rounded-lg border py-2 pl-9 pr-16 text-sm outline-none transition focus:ring-2",
                phone.kind === "invalid"
                  ? "border-amber-300 bg-amber-50 focus:border-amber-400 focus:ring-amber-100"
                  : "border-gray-300 focus:border-brand-500 focus:ring-brand-100",
              )}
            />
            <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
              {phone.ok && (
                <span title={`Valid: ${phone.pretty}`} className="flex">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                </span>
              )}
              {phone.kind === "invalid" && (
                <AlertTriangle className="h-4 w-4 text-amber-500" />
              )}
              {wa && (
                <a
                  href={wa}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Message on WhatsApp"
                  className="rounded-md p-1 text-emerald-600 transition hover:bg-emerald-50"
                >
                  <MessageCircle className="h-4 w-4" />
                </a>
              )}
            </div>
          </div>

          {value.phone.trim() !== "" && (
            <p
              className={cn(
                "mt-1 text-xs",
                phone.kind === "invalid" ? "text-amber-700" : "text-gray-500",
              )}
            >
              {phone.kind === "invalid"
                ? phone.message
                : `Will print as ${phone.pretty}`}
              {phone.kind === "invalid" && (
                <span className="block text-gray-500">
                  It will still be printed exactly as you typed it.
                </span>
              )}
            </p>
          )}
        </div>
      </div>

      {/* Reference number */}
      {!compact && onRefChange && (
        <div className="mt-3 sm:w-1/2">
          <label className="mb-1 block text-xs font-medium text-gray-600">
            Reference no.
          </label>
          <div className="relative">
            <Hash className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              value={refNo ?? ""}
              onChange={(e) => onRefChange(e.target.value)}
              placeholder="BB-260809-001"
              className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Numbered automatically. Edit it if you use your own numbering.
          </p>
        </div>
      )}
    </div>
  );
}
