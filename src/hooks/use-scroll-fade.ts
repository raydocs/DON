import { type RefObject, useEffect } from "react";

/**
 * Track scroll position on a vertical scroll container and write the result
 * to `data-fade-top` / `data-fade-bottom` attributes on the element. The
 * `.scroll-fade` CSS utility in `globals.css` reads these attributes and
 * shows fade gradients only in directions that are actually scrollable.
 *
 * A ResizeObserver watches the container and its direct content roots so
 * internal content height changes recompute the fade state without observing
 * every row mutation in large or virtualized lists.
 */
export function useScrollFade<T extends HTMLElement>(
  ref: RefObject<T | null>,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      const fadeTop = el.scrollTop > 1;
      const fadeBottom = el.scrollHeight - el.clientHeight - el.scrollTop > 1;
      el.setAttribute("data-fade-top", fadeTop ? "true" : "false");
      el.setAttribute("data-fade-bottom", fadeBottom ? "true" : "false");
    };

    update();
    el.addEventListener("scroll", update, { passive: true });

    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);

    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [ref]);
}
