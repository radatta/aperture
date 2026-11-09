// For the app-only deploy tier: reproduce the cdk-outputs.<stage>.json that `cdk deploy --outputs-file`
// writes, WITHOUT running cdk deploy. An app-only change (app/** only) doesn't touch infra, so the
// pipeline skips synth/diff/deploy — but publish-frontend.mjs + health-check.mjs still read that
// outputs file. So fetch the same values straight from CloudFormation and write them in the identical
// shape. Needs `cloudformation:DescribeStacks` on the two stacks (granted to the CI role in
// cicd-stack.ts) + the `aws` CLI; region comes from AWS_REGION (set by configure-aws-credentials).
// Usage: node scripts/aws/fetch-stack-outputs.mjs [dev|prod]
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const stage = process.argv[2] ?? 'dev';
const root = fileURLToPath(new URL('../..', import.meta.url));
const stacks = [`ApertureData-${stage}`, `ApertureApp-${stage}`];

const outputs = {};
for (const stack of stacks) {
  const json = execFileSync(
    'aws',
    [
      'cloudformation',
      'describe-stacks',
      '--stack-name',
      stack,
      '--query',
      'Stacks[0].Outputs',
      '--output',
      'json',
    ],
    { encoding: 'utf8' },
  );
  const arr = JSON.parse(json) ?? [];
  // {OutputKey, OutputValue}[] → { Key: Value } — the shape --outputs-file nests under each stack name.
  outputs[stack] = Object.fromEntries(arr.map((o) => [o.OutputKey, o.OutputValue]));
}

const dest = `${root}/cdk/cdk-outputs.${stage}.json`;
writeFileSync(dest, `${JSON.stringify(outputs, null, 2)}\n`);
console.log(`✓ Wrote cdk-outputs.${stage}.json from CloudFormation (${stacks.join(', ')})`);
