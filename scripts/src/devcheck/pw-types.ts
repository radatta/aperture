// The slice of Playwright's API the dev check uses, typed by hand. Playwright is deliberately not a
// dependency of any package (docs/ops/DEV-CHECK.md → Playwright): it loads at runtime from the shared ~/pw
// install, so CI never installs it and `scripts` tests never need a browser. Grow this as scenarios need more.
export interface PwResponse {
  url(): string;
  status(): number;
  request(): { method(): string; postData?(): string | null }; // the same Request object the `request` event carried — stable identity
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface PwRequest {
  url(): string;
  method(): string;
  postData(): string | null;
  response(): Promise<PwResponse | null>;
  failure?(): { errorText: string } | null; // set once the request failed (`requestfailed`)
}

export interface PwLocator {
  first(): PwLocator;
  last(): PwLocator;
  filter(opts: { hasText: string }): PwLocator;
  click(opts?: { timeout?: number }): Promise<void>;
  fill(value: string, opts?: { timeout?: number }): Promise<void>;
  press(key: string, opts?: { timeout?: number }): Promise<void>;
  waitFor(opts?: { state?: 'visible' | 'attached' | 'hidden'; timeout?: number }): Promise<void>;
  isVisible(): Promise<boolean>;
  isDisabled(): Promise<boolean>;
  isChecked(): Promise<boolean>;
  nth(index: number): PwLocator;
  filter(opts: { hasText?: string | RegExp }): PwLocator;
  getAttribute(name: string): Promise<string | null>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  or(other: PwLocator): PwLocator;
  textContent(): Promise<string | null>;
  inputValue(): Promise<string>;
  scrollIntoViewIfNeeded(opts?: { timeout?: number }): Promise<void>;
  count(): Promise<number>;
  locator(selector: string): PwLocator; // a CSS or `xpath=` selector under this one (an ancestor row too)
  getByRole(
    role: string,
    opts?: {
      name?: string | RegExp;
      exact?: boolean;
      checked?: boolean;
      disabled?: boolean;
      expanded?: boolean;
    },
  ): PwLocator;
  getByLabel(text: string | RegExp, opts?: { exact?: boolean }): PwLocator;
  getByText(text: string | RegExp, opts?: { exact?: boolean }): PwLocator;
  // A <select>: by an option's visible label (what the user picks), never its value.
  selectOption(option: { label: string }, opts?: { timeout?: number }): Promise<string[]>;
}

export interface PwPage {
  goto(
    url: string,
    opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number },
  ): Promise<unknown>;
  reload(opts?: { waitUntil?: 'load' | 'domcontentloaded' }): Promise<unknown>;
  waitForResponse(
    match: (res: PwResponse) => boolean,
    opts?: { timeout?: number },
  ): Promise<PwResponse>;
  // A narrower phone for one step (390×844, the floor); set it back to PHONE after the shot.
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  url(): string;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  // A real (trusted) click at viewport coordinates — the lc-e2e clicks inside closed shadow roots.
  mouse?: { click(x: number, y: number): Promise<void> };
  locator(selector: string): PwLocator;
  getByRole(
    role: string,
    opts?: {
      name?: string | RegExp;
      exact?: boolean;
      checked?: boolean;
      disabled?: boolean;
      expanded?: boolean;
    },
  ): PwLocator;
  getByText(text: string | RegExp, opts?: { exact?: boolean }): PwLocator;
  getByLabel(text: string | RegExp, opts?: { exact?: boolean }): PwLocator;
  waitForURL(
    url: string | RegExp | ((u: URL) => boolean),
    opts?: { timeout?: number },
  ): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  // A script run in every document this page loads, before its own (the lc-e2e sets the fake page's switches).
  addInitScript?(script: string): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<unknown>;
  on(event: 'console', fn: (msg: { type(): string; text(): string }) => void): void;
  on(event: 'pageerror', fn: (err: Error) => void): void;
  on(event: 'request', fn: (req: PwRequest) => void): void;
  on(event: 'requestfailed', fn: (req: PwRequest) => void): void;
  on(event: 'response', fn: (res: PwResponse) => void): void;
  off(event: 'request', fn: (req: PwRequest) => void): void;
  off(event: 'requestfailed', fn: (req: PwRequest) => void): void;
  off(event: 'response', fn: (res: PwResponse) => void): void;
  route(
    url: string | RegExp | ((u: URL) => boolean),
    handler: (route: PwRoute) => Promise<void> | void,
  ): Promise<void>;
  unroute(
    url: string | RegExp | ((u: URL) => boolean),
    handler?: (route: PwRoute) => Promise<void> | void,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface PwRoute {
  request(): PwRequest;
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
  fallback(): Promise<void>; // on to the next matching route (or the network) — what a pass-through should use
  fulfill(opts: { status: number; body?: string; headers?: Record<string, string> }): Promise<void>;
}

export interface PwContext {
  newPage(): Promise<PwPage>;
  storageState(): Promise<unknown>;
  close(): Promise<void>;
  // A persistent context with an extension loaded (scripts/src/lc-e2e): its background service worker, and
  // routes that see every page's requests.
  serviceWorkers?(): PwWorker[];
  waitForEvent?(event: 'serviceworker', opts?: { timeout?: number }): Promise<PwWorker>;
  route?(
    url: string | RegExp | ((u: URL) => boolean),
    handler: (route: PwRoute) => Promise<void> | void,
  ): Promise<void>;
}

export interface PwWorker {
  url(): string;
  evaluate<T>(expression: string): Promise<T>;
}

export interface PwBrowser {
  newContext(opts: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}

export interface PwModule {
  chromium: {
    launch(opts: Record<string, unknown>): Promise<PwBrowser>;
    launchPersistentContext?(
      userDataDir: string,
      opts: Record<string, unknown>,
    ): Promise<PwContext>;
  };
}
