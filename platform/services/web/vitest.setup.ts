/**
 * What jsdom does not implement.
 *
 * jsdom has no media queries, and ThemeToggle asks for the prefers-color-scheme
 * one on mount, so every component test that renders any chrome would fail on
 * it. Stubbed as "light", which is the theme a test should be asserting
 * against: dark is a separate palette, not an inversion, and a test that
 * silently ran in it would be asserting the wrong colours.
 *
 * Guarded, because most files here run in the node environment and have no
 * window at all.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

/**
 * jsdom has no top layer, so <dialog> is inert.
 *
 * showModal and close are unimplemented, which means every component built on
 * the native element throws on first render rather than failing an assertion.
 * The stubs keep the element's own `open` property honest, since that is what
 * the component reads back to decide whether to call either method, and a stub
 * that did not would leave it calling showModal on every render.
 *
 * Deliberately not a full implementation: there is no focus trap and no
 * inertness here, so a test must not use this to assert either.
 */
if (typeof window !== 'undefined' && typeof HTMLDialogElement === 'function') {
  const dialog = HTMLDialogElement.prototype
  if (typeof dialog.showModal !== 'function') {
    dialog.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true
    }
    dialog.show = function show(this: HTMLDialogElement) {
      this.open = true
    }
    dialog.close = function close(this: HTMLDialogElement) {
      this.open = false
      this.dispatchEvent(new Event('close'))
    }
  }
}
