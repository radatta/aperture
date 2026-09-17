import { describe, it, expect } from 'vitest';
import { classify, classifyPath } from './classify-changes';

describe('classify-changes', () => {
  it('classifies docs/ and top-level *.md as none', () => {
    expect(classifyPath('docs/RECRUITING.md')).toBe('none'); // the bug: this used to fall through to full
    expect(classifyPath('docs/nested/deep.md')).toBe('none');
    expect(classifyPath('README.md')).toBe('none');
    expect(classifyPath('CLAUDE.md')).toBe('none');
  });

  it('classifies app/ as app', () => {
    expect(classifyPath('app/src/routes/Home.tsx')).toBe('app');
    expect(classifyPath('app/index.html')).toBe('app');
  });

  it('classifies everything deployable as full', () => {
    expect(classifyPath('lambdas/src/index.ts')).toBe('full');
    expect(classifyPath('cdk/src/lib/app-stack.ts')).toBe('full');
    expect(classifyPath('packages/shared/src/index.ts')).toBe('full'); // feeds both app AND lambdas
    expect(classifyPath('scripts/src/smoke.ts')).toBe('full');
    expect(classifyPath('package.json')).toBe('full');
    expect(classifyPath('pnpm-lock.yaml')).toBe('full');
    expect(classifyPath('.github/workflows/deploy.yml')).toBe('full');
    expect(classifyPath('extension/content.js')).toBe('full'); // conservative default, not yet promoted
  });

  it('takes the max tier across a mixed changeset', () => {
    expect(classify(['docs/x.md', 'README.md'])).toBe('none');
    expect(classify(['app/src/x.tsx', 'docs/y.md'])).toBe('app');
    expect(classify(['app/src/x.tsx', 'lambdas/src/y.ts'])).toBe('full');
    expect(classify(['packages/shared/src/x.ts'])).toBe('full');
  });

  it('treats an empty changeset as full (safe default)', () => {
    expect(classify([])).toBe('full');
    expect(classify(['', '  ', '\n'])).toBe('full');
  });

  it('ignores blank lines from a trailing newline in git output', () => {
    expect(classify(['docs/a.md', '', 'docs/b.md'])).toBe('none');
  });
});
