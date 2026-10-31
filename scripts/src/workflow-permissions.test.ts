import { readdirSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { checkCallers, parseWorkflow } from './workflow-permissions';

const DIR = new URL('../../.github/workflows/', import.meta.url);
const repoWorkflows = () =>
  Object.fromEntries(
    readdirSync(DIR)
      .filter((f) => f.endsWith('.yml'))
      .map((f) => [f, readFileSync(new URL(f, DIR), 'utf8')]),
  );

// The PR 69 shape: the called job declares deployments: read, the caller grants less.
const STAGE = `on:
  workflow_call:
permissions:
  id-token: write
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
      deployments: read # comment
    steps:
      - run: |
          permissions:
            contents: write
`;
const caller = (perms: string) => `on:
  push:
permissions:
  contents: read
jobs:
  deploy-dev:
${perms}    uses: ./.github/workflows/stage.yml
`;

describe('workflow-permissions', () => {
  it("passes on this repo's workflows", () => {
    const report = checkCallers(repoWorkflows());
    expect(report.problems).toEqual([]);
    // a caller with no permissions anywhere runs with the repo default — a new entry here needs a look
    expect(report.unchecked).toEqual([]);
  });

  it('catches a caller granting less than the called job declares (PR 69)', () => {
    const files = {
      'stage.yml': STAGE,
      'deploy.yml': caller('    permissions:\n      id-token: write\n      contents: read\n'),
    };
    expect(checkCallers(files).problems).toEqual([
      'deploy.yml › deploy-dev grants deployments: none, but stage.yml › deploy declares deployments: read',
    ]);
  });

  it('passes once the caller grants it, and write covers read', () => {
    const grants =
      '    permissions:\n      id-token: write\n      contents: write\n      deployments: read\n';
    expect(checkCallers({ 'stage.yml': STAGE, 'deploy.yml': caller(grants) }).problems).toEqual([]);
  });

  it("falls back to the caller workflow's top-level permissions, and checks the called top level too", () => {
    const problems = checkCallers({ 'stage.yml': STAGE, 'deploy.yml': caller('') }).problems;
    expect(problems).toContain(
      'deploy.yml › deploy-dev grants id-token: none, but stage.yml (top level) declares id-token: write',
    );
    expect(problems).toContain(
      'deploy.yml › deploy-dev grants deployments: none, but stage.yml › deploy declares deployments: read',
    );
  });

  it('flags a call to a missing workflow', () => {
    expect(checkCallers({ 'deploy.yml': caller('') }).problems).toEqual([
      "deploy.yml › deploy-dev calls stage.yml, which doesn't exist",
    ]);
  });

  it('ignores permissions-looking text inside a run block', () => {
    expect(parseWorkflow(STAGE).jobs.deploy?.perms).toEqual({
      'id-token': 'write',
      contents: 'read',
      deployments: 'read',
    });
  });

  it('refuses permission forms it cannot read rather than guess', () => {
    expect(() => parseWorkflow('permissions: read-all\njobs:\n', 'x.yml')).toThrow(
      /x.yml:1: unsupported permissions form "read-all"/,
    );
    expect(() => parseWorkflow('jobs:\n  a:\n    permissions: {}\n', 'x.yml')).toThrow(
      /unsupported/,
    );
    expect(() => parseWorkflow('permissions:\n  contents: admin\njobs:\n', 'x.yml')).toThrow(
      /x.yml:2: unreadable/,
    );
  });

  // Each of these used to read as fewer permissions or no jobs — a silent pass
  it('throws on shapes that would otherwise read as less', () => {
    expect(() =>
      parseWorkflow(
        'permissions:\n  "contents": read\n  id-token: write\njobs:\n  a:\n    runs-on: x\n',
        'x.yml',
      ),
    ).toThrow(/x.yml:2: unreadable permission line/);
    expect(() =>
      parseWorkflow('jobs:\n    a:\n      permissions:\n        contents: read\n', 'x.yml'),
    ).toThrow(/no jobs read/);
    expect(() =>
      parseWorkflow('jobs:\n  "a":\n    uses: ./.github/workflows/s.yml\n', 'x.yml'),
    ).toThrow(/x.yml:2: unreadable line/);
  });

  it('reads trailing comments and quoted uses', () => {
    const wf = parseWorkflow(
      "jobs:\n  check: # note\n    uses: './.github/workflows/s.yml' # note\n",
    );
    expect(wf.jobs.check?.uses).toBe('./.github/workflows/s.yml');
  });

  it('reports job uses it cannot resolve instead of skipping them', () => {
    const files = {
      's.yml': STAGE,
      'x.yml':
        'permissions:\n  contents: read\njobs:\n  a:\n    uses: ./.github/workflows/s.yml@main\n  b:\n    uses: org/repo/.github/workflows/w.yml@v1\n',
    };
    const report = checkCallers(files);
    expect(report.problems).toEqual([
      'x.yml › a calls "./.github/workflows/s.yml@main", which isn\'t a local workflow file',
    ]);
    expect(report.unchecked).toEqual(['x.yml › b (org/repo/.github/workflows/w.yml@v1)']);
  });
});
