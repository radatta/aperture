import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ApertureCicdStack } from './lib/cicd-stack';

function cicdTemplate(roles: 'prod' | 'dev') {
  const app = new App();
  const stack = new ApertureCicdStack(app, roles === 'prod' ? 'ApertureCicd' : 'ApertureCicdDev', {
    env: { account: roles === 'prod' ? '111111111111' : '222222222222', region: 'us-west-1' },
    githubRepo: 'acme/aperture',
    roles,
  });
  return Template.fromStack(stack);
}
const roleNames = (t: Template) =>
  Object.values(t.findResources('AWS::IAM::Role'))
    .map((r) => (r as { Properties: { RoleName?: string } }).Properties.RoleName)
    .filter(Boolean)
    .sort();

describe('ApertureCicdStack, per account', () => {
  const prod = cicdTemplate('prod');
  const dev = cicdTemplate('dev');

  it('creates one GitHub OIDC provider in each account', () => {
    // CDK backs OpenIdConnectProvider with a custom resource; assert it's present (the named roles are pinned
    // by the trust-subject tests below).
    prod.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 1);
    dev.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 1);
  });

  // A dev credential must never exist in prod's account, nor a prod one in dev's.
  it("puts only prod's role in the management account and only dev's roles in the dev account", () => {
    expect(roleNames(prod)).toEqual(['aperture-github-deploy-prod']);
    expect(roleNames(dev)).toEqual(['aperture-github-deploy-dev', 'aperture-github-dev-main', 'aperture-github-logs-dev']);
  });

  // Redeploying ApertureCicd must update prod's role and OIDC provider in place, never replace them: a new provider
  // or role would break every prod deploy until the trust caught up. These logical ids are main's.
  it("keeps prod's role and OIDC provider at their deployed logical ids", () => {
    const ids = Object.keys(prod.toJSON().Resources as object);
    for (const id of ['DeployProd4D593C1D', 'DeployProdDefaultPolicy4A11419E', 'GithubOidc86785739']) expect(ids).toContain(id);
  });

  it('grants neither deploy role any CloudFront action (publish no longer invalidates)', () => {
    for (const t of [prod, dev]) expect(JSON.stringify(t.findResources('AWS::IAM::Policy'))).not.toContain('cloudfront:');
  });
});

describe('ApertureCicdStack roles', () => {
  const t = cicdTemplate('dev');
  const prodT = cicdTemplate('prod');

  it('trusts the dev role only from the dev environment', () => {
    t.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'aperture-github-deploy-dev',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: Match.objectLike({
              StringLike: {
                // environment:dev — every dev deploy runs in the `dev` GitHub environment, on main (a push or
                // a bot dispatch), so that's the only trusted sub. The cutover ref subs were pruned 2026-08.
                'token.actions.githubusercontent.com:sub': ['repo:acme/aperture:environment:dev'],
              },
            }),
          }),
        ]),
      }),
    });
  });

  it('binds the prod role to the prod GitHub environment (not a branch)', () => {
    prodT.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'aperture-github-deploy-prod',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: {
                'token.actions.githubusercontent.com:sub': ['repo:acme/aperture:environment:prod'],
              },
            }),
          }),
        ]),
      }),
    });
  });

  // The deploy roles' own policies, by role name.
  const statementsOf = (roleName: string) => {
    const tt = roleName.endsWith('-prod') ? prodT : t;
    const [logicalId = ''] = Object.keys(
      tt.findResources('AWS::IAM::Role', { Properties: { RoleName: roleName } }),
    );
    expect(logicalId).not.toBe('');
    return Object.values(tt.findResources('AWS::IAM::Policy'))
      .filter((p) =>
        JSON.stringify((p as { Properties: { Roles: unknown } }).Properties.Roles).includes(
          logicalId,
        ),
      )
      .flatMap(
        (p) =>
          (
            p as {
              Properties: {
                PolicyDocument: { Statement: { Action: unknown; Resource: unknown }[] };
              };
            }
          ).Properties.PolicyDocument.Statement,
      );
  };
  const bootstrapGrants = (roleName: string) =>
    statementsOf(roleName)
      .filter((s) => s.Action === 'sts:AssumeRole' || s.Action === 'ssm:GetParameter')
      .map((s) => JSON.stringify(s.Resource))
      .join(' ');

  it("lets each deploy role assume only its own account's stock bootstrap", () => {
    expect(bootstrapGrants('aperture-github-deploy-dev')).toContain('arn:aws:iam::222222222222:role/cdk-hnb659fds-*-222222222222-');
    expect(bootstrapGrants('aperture-github-deploy-prod')).toContain('arn:aws:iam::111111111111:role/cdk-hnb659fds-*-111111111111-');
    for (const r of ['aperture-github-deploy-dev', 'aperture-github-deploy-prod'])
      expect(bootstrapGrants(r)).not.toContain('devsandbox');
  });

  // Main's own dev deploy (docs/ops/CI-BOT.md → Two lanes): the one role that may enter the freeze-exempt bootstrap.
  it('trusts the dev-main role only from the main-only dev-main environment', () => {
    const [role] = Object.values(t.findResources('AWS::IAM::Role', { Properties: { RoleName: 'aperture-github-dev-main' } })) as {
      Properties: { AssumeRolePolicyDocument: { Statement: { Condition: Record<string, Record<string, unknown>> }[] } };
    }[];
    const subs = role?.Properties.AssumeRolePolicyDocument.Statement.map(
      (s) => s.Condition.StringLike?.['token.actions.githubusercontent.com:sub'],
    );
    expect(subs).toEqual([['repo:acme/aperture:environment:dev-main']]);
  });

  it('lets the dev-main role assume exactly the devmain deploy and lookup roles and the stock publishing role', () => {
    const assume = statementsOf('aperture-github-dev-main').filter((s) => s.Action === 'sts:AssumeRole');
    expect(assume.map((s) => s.Resource)).toEqual([
      [
        'arn:aws:iam::222222222222:role/cdk-devmain-deploy-role-222222222222-us-west-1',
        'arn:aws:iam::222222222222:role/cdk-devmain-lookup-role-222222222222-us-west-1',
        'arn:aws:iam::222222222222:role/cdk-hnb659fds-file-publishing-role-222222222222-us-west-1',
      ],
    ]);
    expect(bootstrapGrants('aperture-github-dev-main')).toContain('parameter/cdk-bootstrap/devmain/version');
    expect(bootstrapGrants('aperture-github-dev-main')).not.toContain('hnb659fds-deploy');
    expect(bootstrapGrants('aperture-github-dev-main')).not.toContain('*');
  });

  it("keeps the frozen lane's role and prod's out of the devmain bootstrap", () => {
    expect(JSON.stringify(statementsOf('aperture-github-deploy-dev'))).not.toContain('devmain');
    expect(JSON.stringify(prodT.toJSON())).not.toContain('devmain');
    expect(JSON.stringify(prodT.toJSON())).not.toContain('dev-main');
  });

  it('gives the dev-main role the same dev publish, smoke and outputs grants as the dev role', () => {
    const rest = (r: string) =>
      statementsOf(r).filter((s) => s.Action !== 'sts:AssumeRole' && s.Action !== 'ssm:GetParameter');
    expect(rest('aperture-github-dev-main')).toEqual(rest('aperture-github-deploy-dev'));
  });

  it('grants deploy power only by assuming the CDK bootstrap roles', () => {
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Action: 'sts:AssumeRole' })]),
      }),
    });
  });

  it('trusts the logs role only from the main-only dev-logs environment', () => {
    t.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'aperture-github-logs-dev',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: {
                'token.actions.githubusercontent.com:sub': [
                  'repo:acme/aperture:environment:dev-logs',
                ],
              },
            }),
          }),
        ]),
      }),
    });
  });

  it('lets the logs role read only the three dev Lambda groups, and nothing else', () => {
    const roles = t.findResources('AWS::IAM::Role', {
      Properties: { RoleName: 'aperture-github-logs-dev' },
    });
    const [logicalId = ''] = Object.keys(roles);
    expect(logicalId).not.toBe('');
    const policies = Object.values(t.findResources('AWS::IAM::Policy')).filter((p) =>
      JSON.stringify((p as { Properties: { Roles: unknown } }).Properties.Roles).includes(
        logicalId,
      ),
    );
    const stmts = policies.flatMap(
      (p) =>
        (
          p as {
            Properties: {
              PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] };
            };
          }
        ).Properties.PolicyDocument.Statement,
    );
    const actions = stmts.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions.every((a) => a.startsWith('logs:'))).toBe(true); // no bootstrap assume, S3, CFN
    const resources = JSON.stringify(stmts.map((s) => s.Resource));
    for (const fn of ['bff', 'mcp', 'finance-sync'])
      expect(resources).toContain(`/aws/lambda/aperture-${fn}-dev:*`);
    expect(resources).not.toContain('-prod');
    // Only the three id-addressed query calls sit on `*`.
    const star = stmts
      .filter((s) => s.Resource === '*')
      .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(star.sort()).toEqual(['logs:DescribeQueries', 'logs:GetQueryResults', 'logs:StopQuery']);
  });

  it('grants read-only DescribeStacks for the app-only deploy tier', () => {
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Action: 'cloudformation:DescribeStacks' })]),
      }),
    });
  });
});
