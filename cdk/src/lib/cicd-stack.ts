import { CfnOutput, Duration, Stack, Token, Validations } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { DEV_SLOTS } from '@aperture/shared';
import { DEV_MAIN_GITHUB_ROLE, DEVMAIN_QUALIFIER, STOCK_QUALIFIER } from '../config/devAccount';

export interface CicdStackProps extends StackProps {
  // Which account this copy is for (INFRA §2): 'prod' → the management account's prod deploy role (ApertureCicd);
  // 'dev' → the dev account's deploy + dev-logs roles (ApertureCicdDev). Each account has its own OIDC provider.
  roles: 'prod' | 'dev';
  githubRepo: string; // 'owner/repo' — human-facing slug; also the default OIDC subject segment
  // The owner/repo segment as it actually appears in the token's `sub` claim. Defaults to githubRepo.
  // Some enterprises/orgs enforce a custom OIDC subject that embeds the immutable owner/repo IDs
  // (e.g. 'owner@123/repo@456'); when that's in effect the name-based slug won't match, so pass the
  // real segment via `-c githubSubject=...`. Kept out of committed code (deploy-time context).
  githubSubject?: string;
}

// The dev Lambdas whose logs `pnpm bot logs` reads, on each dev slot (scripts/src/bot/logs-spec.ts lists the same).
export const LOG_FNS = ['bff', 'mcp', 'finance-sync', 'push-dispatch'] as const;

const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';
const GITHUB_OIDC_URL = `https://${GITHUB_OIDC_HOST}`;
const BOOTSTRAP_QUALIFIER = STOCK_QUALIFIER; // each account's stock CDK bootstrap (cdk-hnb659fds-*-role)

// Deployed ONCE per account, by hand, before CI can run — chicken-and-egg: the roles must exist for GitHub to
// assume them. Creates the account's GitHub OIDC provider plus its keyless roles, then the pipeline never touches
// it (re-run by hand when a role changes — INFRA §9). The roles hold almost no direct power: cdk deploy is
// funneled through the account's CDK bootstrap roles, which carry the real permissions, and the roles get only
// the handful of direct actions the frontend publish + smoke step take outside CloudFormation. Each stage's
// role lives in its own account (dev's in the dev account, under its SCPs — org-stack.ts), so a dev credential
// can never touch prod. Prod trust is bound to the `prod` GitHub environment, so the prod role is unassumable
// except from a job that declares `environment: prod` (branch-policy scoped — the prod environment carries no
// required-reviewer approval today).
export class ApertureCicdStack extends Stack {
  constructor(scope: Construct, id: string, props: CicdStackProps) {
    super(scope, id, props);
    const { githubRepo, githubSubject = githubRepo } = props;
    // The trust matches `sub` with StringLike, so a `*` or `?` typed into `-c githubRepo=…` would admit other repos (a
    // fork's among them, once the repo is public), and a `:` would shift the claim's fields. One owner/repo, literally.
    for (const [name, slug] of Object.entries({ githubRepo, githubSubject }))
      if (!/^[^/*?:\s]+\/[^/*?:\s]+$/.test(slug))
        throw new Error(`${name} "${slug}" must be one owner/repo, with no * ? : or spaces`);
    const { account, region } = this;
    // cdk-nag prints a pinned account literally and an unpinned one as the <AWS::AccountId> token; the ack ids below
    // must match either form.
    const nagAccount = Token.isUnresolved(account) ? '<AWS::AccountId>' : account;

    const provider = new iam.OpenIdConnectProvider(this, 'GithubOidc', {
      url: GITHUB_OIDC_URL,
      clientIds: ['sts.amazonaws.com'],
    });

    // lane 'devmain' (dev only): main's own dev deploy, through the second bootstrap (config/lane.ts) — its deploy,
    // lookup and publishing roles, named exactly, and its own version parameter. `stages`: the stages this role
    // publishes and smokes — prod's one, or both dev slots (one account, one role per lane, INFRA §2).
    const makeRole = (
      id: string,
      roleName: string,
      subs: string[],
      stages: readonly string[],
      lane?: typeof DEVMAIN_QUALIFIER,
    ): iam.Role => {
      const role = new iam.Role(this, id, {
        roleName,
        maxSessionDuration: Duration.hours(1),
        // Condition keys use the literal issuer host (not the provider token — a token can't be a map key).
        assumedBy: new iam.OpenIdConnectPrincipal(provider, {
          StringEquals: { [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com' },
          StringLike: { [`${GITHUB_OIDC_HOST}:sub`]: subs },
        }),
      });

      // cdk deploy: assume the account's bootstrap roles (which hold the real deploy power) + read the bootstrap
      // version parameter the CLI checks first.
      const bootstrapRole = (q: string, kind: string) =>
        `arn:aws:iam::${account}:role/cdk-${q}-${kind}-${account}-${region}`;
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: lane
            ? ['deploy-role', 'lookup-role', 'file-publishing-role'].map((kind) =>
                bootstrapRole(lane, kind),
              )
            : [bootstrapRole(BOOTSTRAP_QUALIFIER, '*')],
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [
            `arn:aws:ssm:${region}:${account}:parameter/cdk-bootstrap/${lane ?? BOOTSTRAP_QUALIFIER}/version`,
          ],
        }),
      );
      // Frontend publish (S3 sync) + smoke (direct Lambda invoke) — outside CFN, scoped to this stage's
      // resources. No CloudFront invalidation: every un-hashed file is uploaded no-store, so the edge serves a new
      // build without one (publish-frontend.mjs), and paths past the free 1,000 a month are billed per path.
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['s3:PutObject', 's3:DeleteObject', 's3:GetObject', 's3:ListBucket'],
          resources: stages.flatMap((stage) => [
            `arn:aws:s3:::apertureapp-${stage}-*`,
            `arn:aws:s3:::apertureapp-${stage}-*/*`,
          ]),
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: stages.map(
            (stage) => `arn:aws:lambda:${region}:${account}:function:aperture-bff-${stage}`,
          ),
        }),
      );
      // App-only deploys skip `cdk deploy`, so they can't read its --outputs-file; fetch-stack-outputs.mjs
      // reads the same values straight from CloudFormation instead. Read-only, scoped to this stage's stacks.
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['cloudformation:DescribeStacks'],
          resources: stages.flatMap((stage) => [
            `arn:aws:cloudformation:${region}:${account}:stack/ApertureData-${stage}/*`,
            `arn:aws:cloudformation:${region}:${account}:stack/ApertureApp-${stage}/*`,
          ]),
        }),
      );

      // cdk-nag IAM5: every wildcard in this deploy role is deliberate — assuming the account bootstrap
      // roles, the stage's hash-suffixed site bucket, and the app-tier DescribeStacks. Acknowledge each with
      // evidence, as raw acknowledgment metadata — the same cdk-nag#2359 workaround as app-stack.ts. The
      // ids must match synth's "Acknowledge with '...'" hint verbatim; region is literal (us-west-1) and the
      // account is `nagAccount`, both as they appear in the finding.
      role.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, {
        ...(lane
          ? {}
          : {
              [`AwsSolutions-IAM5[Resource::arn:aws:iam::${nagAccount}:role/cdk-${BOOTSTRAP_QUALIFIER}-*-${nagAccount}-${region}]`]:
                'cdk deploy assumes the account CDK bootstrap roles; their names carry the qualifier + a role-type wildcard by design.',
            }),
        ...Object.fromEntries(
          stages.flatMap((stage) => [
            [
              `AwsSolutions-IAM5[Resource::arn:aws:s3:::apertureapp-${stage}-*]`,
              `Frontend publish syncs to the ${stage} site bucket, whose name CDK suffixes with a hash → wildcard.`,
            ],
            [
              `AwsSolutions-IAM5[Resource::arn:aws:s3:::apertureapp-${stage}-*/*]`,
              `Object-level access to the same ${stage} site bucket.`,
            ],
            [
              `AwsSolutions-IAM5[Resource::arn:aws:cloudformation:${region}:${nagAccount}:stack/ApertureApp-${stage}/*]`,
              'app-tier deploy reads stack outputs via DescribeStacks; CFN stack ARNs carry a wildcard suffix.',
            ],
            [
              `AwsSolutions-IAM5[Resource::arn:aws:cloudformation:${region}:${nagAccount}:stack/ApertureData-${stage}/*]`,
              'Same, for the data stack outputs.',
            ],
          ]),
        ),
      });
      return role;
    };

    if (props.roles === 'prod') {
      // prod: environment-based — only a job running in the `prod` environment gets this sub (no
      // required reviewers are configured on it today — INFRA §9 caveat).
      const prodRole = makeRole(
        'DeployProd',
        'aperture-github-deploy-prod',
        [`repo:${githubSubject}:environment:prod`],
        ['prod'],
      );
      new CfnOutput(this, 'ProdRoleArn', { value: prodRole.roleArn });
      return;
    }

    // dev: the frozen lane — deploy-dev.yml on a bot dispatch (and deploy.yml's on a `dev` push, until dev-cutover) — runs in
    // the `dev` GitHub environment, so its OIDC sub is `…:environment:dev` and the trust is scoped to the environment
    // alone. A `main` push deploys dev through the dev-main role below instead.
    const devRole = makeRole(
      'DeployDev',
      'aperture-github-deploy-dev',
      [`repo:${githubSubject}:environment:dev`],
      DEV_SLOTS,
    );
    // dev-main: main's own dev deploy (deploy.yml on a `main` push), in the main-only `dev-main` environment, through
    // the `devmain` bootstrap the freeze exempts (docs/ops/CI-BOT.md → Two lanes). The guardrails SCP lets only this
    // role assume that bootstrap's roles, and lets nothing but break-glass change it.
    const devMainRole = makeRole(
      'DeployDevMain',
      DEV_MAIN_GITHUB_ROLE,
      [`repo:${githubSubject}:environment:dev-main`],
      DEV_SLOTS,
      DEVMAIN_QUALIFIER,
    );

    // dev logs: read-only CloudWatch Logs for fetch-dev-logs.yml (the bot's `pnpm bot logs`). Built apart from
    // makeRole — it gets none of the deploy power (no bootstrap assume, S3, CFN). Trusted only from
    // the `dev-logs` environment (main-only branch policy), and reads only the dev slots' Lambda groups (LOG_FNS, on
    // both slots): prod logs hold the user's real activity and stay unreachable by construction.
    const logsRole = new iam.Role(this, 'LogsDev', {
      roleName: 'aperture-github-logs-dev',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: { [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com' },
        StringLike: { [`${GITHUB_OIDC_HOST}:sub`]: [`repo:${githubSubject}:environment:dev-logs`] },
      }),
    });
    const groupNames = DEV_SLOTS.flatMap((slot) => LOG_FNS.map((fn) => `aperture-${fn}-${slot}`));
    const devGroups = groupNames.map(
      (name) => `arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${name}:*`,
    );
    logsRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:FilterLogEvents',
          'logs:GetLogEvents',
          'logs:DescribeLogStreams',
          'logs:StartQuery',
        ],
        resources: devGroups,
      }),
    );
    // Query results, listings and stopping a query are addressed by query id, not log group — no resource form.
    logsRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:GetQueryResults', 'logs:DescribeQueries', 'logs:StopQuery'],
        resources: ['*'],
      }),
    );
    logsRole.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, {
      ...Object.fromEntries(
        groupNames.map((name) => [
          `AwsSolutions-IAM5[Resource::arn:aws:logs:${region}:${nagAccount}:log-group:/aws/lambda/${name}:*]`,
          'Log events live under the group ARN with a `:*` stream suffix; the group itself is named exactly.',
        ]),
      ),
      'AwsSolutions-IAM5[Resource::*]':
        'logs:GetQueryResults, DescribeQueries and StopQuery are addressed by query id and support no resource-level scoping.',
    });

    new CfnOutput(this, 'DevRoleArn', { value: devRole.roleArn });
    new CfnOutput(this, 'DevMainRoleArn', { value: devMainRole.roleArn });
    new CfnOutput(this, 'LogsRoleArn', { value: logsRole.roleArn });
  }
}
