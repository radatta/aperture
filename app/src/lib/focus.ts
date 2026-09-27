// Move focus without the browser's own jump, then scroll the element just into view — which honours
// the root scroll-padding, so it lands above the bottom dock. (Focus scrolling doesn't reliably apply
// scroll-padding, hence the explicit scroll; `?.` because jsdom has no scrollIntoView.)
export function revealFocus(el: HTMLElement | null | undefined): void {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView?.({ block: 'nearest' });
}
