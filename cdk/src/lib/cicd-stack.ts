import { CfnOutput, Duration, Stack, Validations } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface CicdStackProps extends StackProps {
  githubRepo: string; // 'owner/repo' — human-facing slug; also the default OIDC subject segment
  // The owner/repo segment as it actually appears in the token's `sub` claim. Defaults to githubRepo.
  // Some enterprises/orgs enforce a custom OIDC subject that embeds the immutable owner/repo IDs
  // (e.g. 'owner@123/repo@456'); when that's in effect the name-based slug won't match, so pass the
  // real segment via `-c githubSubject=...`. Kept out of committed code (deploy-time context).
  githubSubject?: string;
}

const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';
const GITHUB_OIDC_URL = `https://${GITHUB_OIDC_HOST}`;
const CDK_QUALIFIER = 'hnb659fds'; // default bootstrap qualifier (cdk-hnb659fds-*-role)

// Deployed ONCE, by hand, before CI can run — chicken-and-egg: the roles must exist for GitHub to assume
// them. Creates the GitHub OIDC provider + two keyless deploy roles, then the pipeline never touches it.
// The roles hold almost no direct power: cdk deploy is funneled through the account's CDK bootstrap roles
// (they carry the real permissions), and the roles get only the handful of direct actions the frontend
// publish + smoke step take outside CloudFormation. Prod trust is bound to the `prod` GitHub environment,
// so the prod role is unassumable except from a job that declares `environment: prod` (branch-policy
// scoped — the prod environment carries no required-reviewer approval today).
export class ApertureCicdStack extends Stack {
  constructor(scope: Construct, id: string, props: CicdStackProps) {
    super(scope, id, props);
    const { githubRepo, githubSubject = githubRepo } = props;
    const { account, region } = this;

    const provider = new iam.OpenIdConnectProvider(this, 'GithubOidc', {
      url: GITHUB_OIDC_URL,
      clientIds: ['sts.amazonaws.com'],
    });

    const makeRole = (id: string, roleName: string, subs: string[], stage: string): iam.Role => {
      const role = new iam.Role(this, id, {
        roleName,
        maxSessionDuration: Duration.hours(1),
        // Condition keys use the literal issuer host (not the provider token — a token can't be a map key).
        assumedBy: new iam.OpenIdConnectPrincipal(provider, {
          StringEquals: { [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com' },
          StringLike: { [`${GITHUB_OIDC_HOST}:sub`]: subs },
        }),
      });

      // cdk deploy: assume the bootstrap roles (which hold the real deploy power) + read the bootstrap
      // version parameter the CLI checks first.
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: [`arn:aws:iam::${account}:role/cdk-${CDK_QUALIFIER}-*-${account}-${region}`],
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [`arn:aws:ssm:${region}:${account}:parameter/cdk-bootstrap/${CDK_QUALIFIER}/version`],
        }),
      );
      // Frontend publish (S3 sync + CloudFront invalidate) + smoke (direct Lambda invoke) — outside CFN,
      // scoped to this stage's resources.
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['s3:PutObject', 's3:DeleteObject', 's3:GetObject', 's3:ListBucket'],
          resources: [`arn:aws:s3:::apertureapp-${stage}-*`, `arn:aws:s3:::apertureapp-${stage}-*/*`],
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
          resources: [`arn:aws:cloudfront::${account}:distribution/*`],
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [`arn:aws:lambda:${region}:${account}:function:aperture-bff-${stage}`],
        }),
      );
      // App-only deploys skip `cdk deploy`, so they can't read its --outputs-file; fetch-stack-outputs.mjs
      // reads the same values straight from CloudFormation instead. Read-only, scoped to this stage's stacks.
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['cloudformation:DescribeStacks'],
          resources: [
            `arn:aws:cloudformation:${region}:${account}:stack/ApertureData-${stage}/*`,
            `arn:aws:cloudformation:${region}:${account}:stack/ApertureApp-${stage}/*`,
          ],
        }),
      );

      // cdk-nag IAM5: every wildcard in this deploy role is deliberate — assuming the account bootstrap
      // roles, the stage's hash-suffixed site bucket, CloudFront invalidation (the distribution id isn't
      // known until the app stack deploys), and the app-tier DescribeStacks. Acknowledge each with
      // evidence, as raw acknowledgment metadata — the same cdk-nag#2359 workaround as app-stack.ts. The
      // ids must match synth's "Acknowledge with '...'" hint verbatim; region is literal (us-west-1) and
      // account stays the `<AWS::AccountId>` token, both as they appear in the finding.
      role.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, {
        [`AwsSolutions-IAM5[Resource::arn:aws:iam::<AWS::AccountId>:role/cdk-${CDK_QUALIFIER}-*-<AWS::AccountId>-${region}]`]:
          'cdk deploy assumes the account CDK bootstrap roles; their names carry the qualifier + a role-type wildcard by design.',
        [`AwsSolutions-IAM5[Resource::arn:aws:s3:::apertureapp-${stage}-*]`]:
          `Frontend publish syncs to the ${stage} site bucket, whose name CDK suffixes with a hash → wildcard.`,
        [`AwsSolutions-IAM5[Resource::arn:aws:s3:::apertureapp-${stage}-*/*]`]:
          `Object-level access to the same ${stage} site bucket.`,
        [`AwsSolutions-IAM5[Resource::arn:aws:cloudfront::<AWS::AccountId>:distribution/*]`]:
          'CloudFront invalidation; the distribution id is not known until the app stack deploys.',
        [`AwsSolutions-IAM5[Resource::arn:aws:cloudformation:${region}:<AWS::AccountId>:stack/ApertureApp-${stage}/*]`]:
          'app-tier deploy reads stack outputs via DescribeStacks; CFN stack ARNs carry a wildcard suffix.',
        [`AwsSolutions-IAM5[Resource::arn:aws:cloudformation:${region}:<AWS::AccountId>:stack/ApertureData-${stage}/*]`]:
          'Same, for the data stack outputs.',
      });
      return role;
    };

    // dev: the `deploy-dev` job always runs in the `dev` GitHub environment, which makes its OIDC sub
    // `…:environment:dev` on BOTH the `dev`- and `main`-branch pushes. That's the only path that assumes
    // this role, so the trust is scoped to the environment alone. (The old `ref:refs/heads/{dev,main}` subs were a cutover superset,
    // pruned 2026-08 once every deploy-dev run was confirmed environment-scoped.) The `dev` environment must
    // allow the `dev` AND `main` branches, since deploy-dev runs from both.
    const devRole = makeRole(
      'DeployDev',
      'aperture-github-deploy-dev',
      [`repo:${githubSubject}:environment:dev`],
      'dev',
    );
    // prod: environment-based — only a job running in the `prod` environment gets this sub (no
    // required reviewers are configured on it today — INFRA §9 caveat).
    const prodRole = makeRole(
      'DeployProd',
      'aperture-github-deploy-prod',
      [`repo:${githubSubject}:environment:prod`],
      'prod',
    );

    new CfnOutput(this, 'DevRoleArn', { value: devRole.roleArn });
    new CfnOutput(this, 'ProdRoleArn', { value: prodRole.roleArn });
  }
}
