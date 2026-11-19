// @aperture/scripts — the miss alarm's graph helper (miss.ts): run from a package dir with test files as arguments,
// prints `{ "<abs test>": ["<abs dep>", …] }` — each file's module deps exactly as `vitest related` follows them
// (VitestSpecifications.getTestDependencies, the same walk), without running a test. A file vitest doesn't collect is
// left out. Plain `node` (Node 22 strips types): erasable syntax, node: builtins only, vitest from the package.
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Spec {
  moduleId: string;
}
interface Vitest {
  specifications: {
    globTestSpecifications(): Promise<Spec[]>;
    getTestDependencies(s: Spec): Promise<Set<string>>;
  };
  close(): Promise<void>;
}

const wanted = new Set(process.argv.slice(2).map((f) => resolve(f)));
const dir = realpathSync(join(process.cwd(), 'node_modules', 'vitest'));
const { createVitest } = (await import(pathToFileURL(join(dir, 'dist', 'node.js')).href)) as {
  createVitest(mode: 'test', opts: object, vite: object, extra: object): Promise<Vitest>;
};
const v = await createVitest('test', { watch: false, run: true, reporters: [] }, {}, {});
try {
  const out: Record<string, string[]> = {};
  for (const s of await v.specifications.globTestSpecifications())
    if (wanted.has(s.moduleId))
      out[s.moduleId] = [...(await v.specifications.getTestDependencies(s))];
  process.stdout.write(JSON.stringify(out));
} finally {
  await v.close();
}
