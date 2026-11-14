// about.html and privacy.html name the maintainer and their contact email, which live only in identifiers.json
// (docs/ops/IDENTIFIERS.md). Their templates sit in app/pages/ with {{maintainer.name}} / {{email.contact}}; this
// plugin fills them, HTML-escaped, into the build at the paths public/ used to give them (/about.html,
// /privacy.html — Google's OAuth consent screen links the privacy page), and serves them the same way in dev.
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

export const IDENTITY_PAGES = ['about.html', 'privacy.html'] as const;

interface PageIdentifiers {
  maintainer: { name: string };
  email: { contact: string };
}

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

export const pageValues = (ids: PageIdentifiers): Record<string, string> => ({
  'maintainer.name': ids.maintainer.name,
  'email.contact': ids.email.contact,
});

// Every {{token}} must be known: a typo fails the build rather than shipping a literal brace.
export function fillPage(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const v = values[key];
    if (v === undefined) throw new Error(`identity page: unknown token {{${key}}}`);
    return escapeHtml(v);
  });
}

export function identityPages(pagesDir: URL, identifiersFile: URL): Plugin {
  const render = (page: string) =>
    fillPage(
      readFileSync(new URL(page, pagesDir), 'utf8'),
      pageValues(JSON.parse(readFileSync(identifiersFile, 'utf8')) as PageIdentifiers),
    );
  return {
    name: 'aperture-identity-pages',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const page = (req.url ?? '').split('?')[0]!.slice(1);
        if (!(IDENTITY_PAGES as readonly string[]).includes(page)) return next();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(render(page));
      });
    },
    generateBundle() {
      for (const page of IDENTITY_PAGES)
        this.emitFile({ type: 'asset', fileName: page, source: render(page) });
    },
  };
}
