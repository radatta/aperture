import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  emit,
  fromCloudFormation,
  masksFor,
  masksIn,
  masksWithFallback,
  run,
  type Outputs,
} from './mask-function-url';

// Synthetic: 32 lowercase alphanumerics, the shape AWS mints.
const ID = 'abcdefghijklmnop0123456789qrstuv';
const HOST = `${ID}.lambda-url.us-west-1.on.aws`;
const URL_ = `https://${HOST}/`;

const lines = () => {
  const out: string[] = [];
  return { out, log: (l: string) => void out.push(l) };
};
const missing = (stack: string) =>
  Object.assign(new Error('Command failed'), {
    stderr: `An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${stack} does not exist`,
  });

describe('masksFor', () => {
  it.each([
    ['the output as CDK writes it', URL_],
    ['without the trailing slash', `https://${HOST}`],
    ['without the scheme', HOST],
    ['with a path', `https://${HOST}/api/health`],
    ['with a query', `https://${HOST}?x=1`],
    ['in upper case', URL_.toUpperCase()],
  ])('masks the host and the url-id: %s', (_, v) => {
    expect(masksFor(v)).toEqual([HOST, ID]);
  });

  it.each([
    ['the custom domain', 'https://dev.aperture.example.dev'],
    ['a CloudFront domain', 'd1234abcd.cloudfront.net'],
    ['a bucket name', 'aperture-site-dev'],
    ['the MCP URL on the custom domain', 'https://dev.aperture.example.dev/mcp'],
    ['an id too short to be AWS-minted', 'https://abc.lambda-url.us-west-1.on.aws/'],
    ['empty', ''],
  ])('ignores %s', (_, v) => {
    expect(masksFor(v)).toEqual([]);
  });
});

describe('masksIn', () => {
  it('picks every Function URL whatever its key, once each', () => {
    const other = `zyxwvutsrqponmlk9876543210abcdef.lambda-url.us-west-1.on.aws`;
    const outputs: Outputs = {
      'ApertureData-dev': { TableName: 'aperture-dev' },
      'ApertureApp-dev': {
        AppUrl: 'https://dev.aperture.example.dev',
        McpUrl: 'https://dev.aperture.example.dev/mcp',
        FunctionUrl: URL_,
        McpFunctionUrl: `https://${other}/`,
        Again: URL_,
      },
    };
    expect(masksIn(outputs)).toEqual([HOST, ID, other, other.split('.')[0]]);
  });
});

describe('masksWithFallback', () => {
  it('warns on a FunctionUrl in an unknown shape and still masks its host', () => {
    const { out, log } = lines();
    expect(
      masksWithFallback({ App: { FunctionUrl: 'https://some-new-shape.example.aws/' } }, log),
    ).toEqual(['some-new-shape.example.aws']);
    expect(out).toEqual([expect.stringMatching(/^::warning::/)]);
    expect(out.join('\n')).not.toContain('some-new-shape');
  });

  it('is silent on a known shape', () => {
    const { out, log } = lines();
    expect(masksWithFallback({ App: { FunctionUrl: URL_ } }, log)).toEqual([HOST, ID]);
    expect(out).toEqual([]);
  });
});

describe('fromCloudFormation', () => {
  it('reads both stacks', () => {
    const asked: string[] = [];
    const describe = (stack: string) => {
      asked.push(stack);
      return stack.startsWith('ApertureApp')
        ? JSON.stringify([{ OutputKey: 'FunctionUrl', OutputValue: URL_ }])
        : 'null'; // a stack with no outputs
    };
    const { out, log } = lines();
    expect(fromCloudFormation('devb', describe, log)).toEqual({
      'ApertureData-devb': {},
      'ApertureApp-devb': { FunctionUrl: URL_ },
    });
    expect(asked).toEqual(['ApertureData-devb', 'ApertureApp-devb']);
    expect(out).toEqual([]);
  });

  it("notes a stack that doesn't exist yet (a first deploy) and goes on", () => {
    const { out, log } = lines();
    const describe = (stack: string) => {
      throw missing(stack);
    };
    expect(fromCloudFormation('prod', describe, log)).toEqual({});
    expect(out).toEqual([
      "::notice::ApertureData-prod doesn't exist yet — nothing to mask",
      "::notice::ApertureApp-prod doesn't exist yet — nothing to mask",
    ]);
  });

  it.each([
    [
      'access denied',
      'An error occurred (AccessDenied) when calling the DescribeStacks operation: not authorized',
    ],
    [
      'a throttle',
      'An error occurred (Throttling) when calling the DescribeStacks operation: Rate exceeded',
    ],
    ['no stderr at all (the CLI missing)', undefined],
  ])('fails closed on %s', (_, stderr) => {
    const describe = () => {
      throw Object.assign(new Error('Command failed'), { stderr });
    };
    expect(() => fromCloudFormation('dev', describe, lines().log)).toThrow('Command failed');
  });
});

describe('emit', () => {
  it('prints the masks and a count, nothing else', () => {
    const { out, log } = lines();
    emit([HOST, ID], 'dev', log);
    expect(out).toEqual([`::add-mask::${HOST}`, `::add-mask::${ID}`, 'masked 2 value(s) for dev']);
  });

  it('says when there was nothing to mask', () => {
    const { out, log } = lines();
    emit([], 'prod', log);
    expect(out).toEqual(["::notice::no Function URL in prod's outputs — nothing masked"]);
  });
});

describe('run', () => {
  const outputsFile = JSON.stringify({ 'ApertureApp-dev': { FunctionUrl: URL_ } });
  const deps = (over: Partial<Parameters<typeof run>[1]> = {}, seen?: string[]) => {
    const { out, log } = lines();
    const read: string[] = [];
    const store = { seen };
    return {
      out,
      read,
      store,
      deps: {
        describe: () => JSON.stringify([{ OutputKey: 'FunctionUrl', OutputValue: URL_ }]),
        readFile: (p: string) => (read.push(p), outputsFile),
        log,
        seen: { load: () => store.seen, save: (m: string[]) => void (store.seen = m) },
        ...over,
      },
    };
  };

  it('masks from CloudFormation by default', () => {
    const d = deps();
    run(['dev'], d.deps);
    expect(d.out).toEqual([
      `::add-mask::${HOST}`,
      `::add-mask::${ID}`,
      'masked 2 value(s) for dev',
    ]);
    expect(d.read).toEqual([]);
    expect(d.store.seen).toEqual([HOST, ID]); // kept for the second pass
  });

  it('is quiet on the second pass when the deploy created no URL', () => {
    const d = deps({}, [HOST, ID]);
    run(['dev', '--from-file'], d.deps);
    expect(d.out.filter((l) => l.startsWith('::warning::'))).toEqual([]);
  });

  it('warns to delete the log when the deploy created a URL, without printing it', () => {
    const d = deps({}, []); // the first pass found no stack (a first deploy)
    run(['dev', '--from-file'], d.deps);
    const warnings = d.out.filter((l) => l.startsWith('::warning::'));
    expect(warnings).toEqual([expect.stringMatching(/delete this run's log/)]);
    expect(warnings.join('\n')).not.toContain(ID);
  });

  it('fails on an unreadable outputs file without quoting it', () => {
    const d = deps({ readFile: () => `{"ApertureApp-dev": {"FunctionUrl": "${URL_}"` });
    expect(() => run(['dev', '--from-file'], d.deps)).toThrow(
      /^cdk-outputs\.dev\.json isn't JSON$/,
    );
  });

  it('masks from the outputs file cdk deploy wrote with --from-file', () => {
    const d = deps({
      describe: () => {
        throw new Error('not called');
      },
    });
    run(['dev', '--from-file'], d.deps);
    expect(d.read).toEqual(['cdk/cdk-outputs.dev.json']);
    expect(d.out).toEqual([
      `::add-mask::${HOST}`,
      `::add-mask::${ID}`,
      'masked 2 value(s) for dev',
    ]);
  });

  it('notes a missing outputs file (the deploy wrote none) and passes', () => {
    const d = deps({
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    run(['devb', '--from-file'], d.deps);
    expect(d.out).toEqual([
      '::notice::no cdk-outputs.devb.json — nothing new to mask',
      "::notice::no Function URL in devb's outputs — nothing masked",
    ]);
  });

  it.each([[[]], [['']], [['dev', '--other']], [['dev', '--from-file', 'x']], [['../dev']]])(
    'refuses argv %j',
    (argv) => {
      expect(() => run(argv, deps().deps)).toThrow(/usage/);
    },
  );
});

// Masks cover only their own job's later lines, so the order in deploy-stage.yml is the whole guarantee.
describe('deploy-stage.yml masks before anything prints an output', () => {
  const DIR = new URL('../../.github/workflows/', import.meta.url);
  const read = (f: string) => readFileSync(new URL(f, DIR), 'utf8');
  const stage = read('deploy-stage.yml');
  const names = stage
    .split('\n')
    .map((l) => /^ {6}- (?:name: (.+)|uses: (\S+))$/.exec(l))
    .filter((m) => m !== null)
    .map((m) => (m[1] ?? m[2])!.replace(/\s+#.*$/, ''));
  const at = (name: string) => {
    const i = names.indexOf(name);
    expect(i, name).toBeGreaterThan(-1);
    return i;
  };
  const step = (name: string) => {
    const from = stage.indexOf(`- name: ${name}`);
    return stage.slice(from, stage.indexOf('\n      - ', from + 1) + 1);
  };

  it('has one job, the deploy', () => {
    expect(stage.match(/^ {2}[a-z-]+:$/gm)).toEqual(['  deploy:']);
  });

  it('masks from CloudFormation once credentials exist, before synth, on every mode that deploys', () => {
    expect(at('Mask Function URLs')).toBeGreaterThan(
      at('aws-actions/configure-aws-credentials@v6'),
    );
    for (const reader of [
      'CDK synth',
      'CDK diff (informational)',
      'Deploy stacks',
      'Unstick a refused dev deploy',
      'Smoke',
      'Fetch stack outputs',
      'Publish frontend',
      'Post-deploy health check',
    ])
      expect(at('Mask Function URLs'), reader).toBeLessThan(at(reader));
    expect(step('Mask Function URLs')).toContain("if: inputs.mode != 'none'");
    expect(step('Mask Function URLs')).toContain(
      'run: node scripts/src/mask-function-url.ts "$APERTURE_STAGE"\n',
    );
  });

  it('masks a URL the deploy created before the steps after it', () => {
    expect(at('Mask new Function URLs')).toBeGreaterThan(at('Deploy stacks'));
    for (const reader of ['Smoke', 'Publish frontend', 'Post-deploy health check'])
      expect(at('Mask new Function URLs'), reader).toBeLessThan(at(reader));
    expect(step('Mask new Function URLs')).toContain("if: inputs.mode == 'full'");
    expect(step('Mask new Function URLs')).toContain(
      'run: node scripts/src/mask-function-url.ts "$APERTURE_STAGE" --from-file\n',
    );
  });

  it('no other workflow reads or prints stack outputs', () => {
    for (const f of readdirSync(DIR).filter((x) => x !== 'deploy-stage.yml'))
      expect(read(f), f).not.toMatch(
        /cdk-outputs|describe-stacks|fetch-stack-outputs|cdk deploy|health-check\.mjs/,
      );
  });
});
