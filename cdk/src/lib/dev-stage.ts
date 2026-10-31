import { DefaultStackSynthesizer } from 'aws-cdk-lib';
import type { Stack, StackSynthesizer } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

// dev's own CDK bootstrap (ApertureDevSandbox, dev-sandbox-stack.ts): roles `cdk-devsandbox-*` that can reach dev
// resources only. One constant feeds the stacks' synthesizer, the sandbox stack and the dev GitHub role (cicd-stack.ts),
// so a typo can't split them. CDK caps a qualifier at 10 lowercase alphanumerics.
export const DEV_QUALIFIER = 'devsandbox';
// The ceiling on every role the dev stacks create, and the CloudFormation execution role's own policy. Both live in
// the sandbox stack; neither is modifiable from the execution role.
export const DEV_BOUNDARY_NAME = 'aperture-dev-boundary';
export const DEV_EXEC_POLICY_NAME = 'aperture-dev-cfn-exec';

// dev synthesizes against the sandbox bootstrap; prod stays on the account default (hnb659fds). A synthesizer binds to
// one stack, so each call makes a fresh one.
export const synthesizerFor = (stage: string): { synthesizer?: StackSynthesizer } =>
  stage === 'dev' ? { synthesizer: new DefaultStackSynthesizer({ qualifier: DEV_QUALIFIER }) } : {};

// The sandbox execution role may create a role only with this boundary attached, so every role in a dev stack —
// CDK's own custom-resource provider roles included (the aspect reaches raw CfnResource roles) — carries it.
export function applyDevBoundary(stack: Stack, stage: string): void {
  if (stage !== 'dev') return;
  iam.PermissionsBoundary.of(stack).apply(
    iam.ManagedPolicy.fromManagedPolicyName(stack, 'DevBoundary', DEV_BOUNDARY_NAME),
  );
}
