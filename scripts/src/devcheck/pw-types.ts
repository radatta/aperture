// The slice of Playwright's API the dev check uses, typed by hand. Playwright is deliberately not a
// dependency of any package (docs/ops/DEV-CHECK.md → Playwright): it loads at runtime from the shared ~/pw
// install, so CI never installs it and `scripts` tests never need a browser. Grow this as scenarios need more.
export interface PwResponse {
  url(): string;
  status(): number;
  request(): { method(): string };
  json(): Promise<unknown>;
}

export interface PwRequest {
  url(): string;
  method(): string;
  response(): Promise<PwResponse | null>;
}

export interface PwLocator {
  first(): PwLocator;
  click(opts?: { timeout?: number }): Promise<void>;
  fill(value: string, opts?: { timeout?: number }): Promise<void>;
  press(key: string, opts?: { timeout?: number }): Promise<void>;
  waitFor(opts?: { state?: 'visible' | 'attached' | 'hidden'; timeout?: number }): Promise<void>;
  isVisible(): Promise<boolean>;
  textContent(): Promise<string | null>;
  inputValue(): Promise<string>;
  count(): Promise<number>;
  getByRole(role: string, opts?: { name?: string | RegExp; exact?: boolean }): PwLocator;
  getByLabel(text: string | RegExp, opts?: { exact?: boolean }): PwLocator;
}

export interface PwPage {
  goto(
    url: string,
    opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number },
  ): Promise<unknown>;
  reload(opts?: { waitUntil?: 'load' | 'domcontentloaded' }): Promise<unknown>;
  url(): string;
  locator(selector: string): PwLocator;
  getByRole(role: string, opts?: { name?: string | RegExp; exact?: boolean }): PwLocator;
  getByText(text: string | RegExp, opts?: { exact?: boolean }): PwLocator;
  getByLabel(text: string | RegExp, opts?: { exact?: boolean }): PwLocator;
  waitForURL(
    url: string | RegExp | ((u: URL) => boolean),
    opts?: { timeout?: number },
  ): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  keyboard: { press(key: string): Promise<void> };
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<unknown>;
  on(event: 'console', fn: (msg: { type(): string; text(): string }) => void): void;
  on(event: 'pageerror', fn: (err: Error) => void): void;
  on(event: 'request', fn: (req: PwRequest) => void): void;
  close(): Promise<void>;
}

export interface PwContext {
  newPage(): Promise<PwPage>;
  storageState(): Promise<unknown>;
  close(): Promise<void>;
}

export interface PwBrowser {
  newContext(opts: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}

export interface PwModule {
  chromium: { launch(opts: Record<string, unknown>): Promise<PwBrowser> };
}
