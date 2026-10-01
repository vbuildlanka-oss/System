"use client";

import { useEffect } from "react";

/**
 * Let the quick-jump (press "/" anywhere) hand a page something to search for.
 *
 * Two ways in, because there are two ways to arrive: from another page the term
 * travels in the address as ?q=, and on the page you are already on - where
 * Next.js does not remount anything - it arrives as an event.
 */
export const FIND_EVENT = "balebook:find";

export interface FindDetail {
  href: string;
  q: string;
}

export function useFind(onFind: (q: string) => void): void {
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) onFind(q);

    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<FindDetail>).detail;
      if (detail && detail.href === window.location.pathname) onFind(detail.q);
    };
    window.addEventListener(FIND_EVENT, onEvent);
    return () => window.removeEventListener(FIND_EVENT, onEvent);
    // The setter is stable; reading the address once on arrival is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
