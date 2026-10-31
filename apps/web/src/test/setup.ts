import '@testing-library/jest-dom/vitest';

// jsdom has no scrolling implementation; geometry-specific tests replace this with an animation spy.
Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
  configurable: true, writable: true,
  value(this: HTMLElement, options: ScrollToOptions) { if (options.top !== undefined) this.scrollTop = options.top; },
});

