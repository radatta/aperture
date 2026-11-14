import { readdirSync, readFileSync } from 'node:fs';
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
    expect(roleNames(dev)).toEqual([
      'aperture-github-deploy-dev',
      'aperture-github-dev-main',
      'aperture-github-logs-dev',
    ]);
  });

  // Redeploying ApertureCicd must update prod's role and OIDC provider in place, never replace them: a new provider
  // or role would break every prod deploy until the trust caught up. These logical ids are main's.
  it("keeps prod's role and OIDC provider at their deployed logical ids", () => {
    const ids = Object.keys(prod.toJSON().Resources as object);
    for (const id of [
      'DeployProd4D593C1D',
      'DeployProdDefaultPolicy4A11419E',
      'GithubOidc86785739',
    ])
      expect(ids).toContain(id);
  });

  it('grants neither deploy role any CloudFront action (publish no longer invalidates)', () => {
    for (const t of [prod, dev])
      expect(JSON.stringify(t.findResources('AWS::IAM::Policy'))).not.toContain('cloudfront:');
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
    expect(bootstrapGrants('aperture-github-deploy-dev')).toContain(
      'arn:aws:iam::222222222222:role/cdk-hnb659fds-*-222222222222-',
    );
    expect(bootstrapGrants('aperture-github-deploy-prod')).toContain(
      'arn:aws:iam::111111111111:role/cdk-hnb659fds-*-111111111111-',
    );
    for (const r of ['aperture-github-deploy-dev', 'aperture-github-deploy-prod'])
      expect(bootstrapGrants(r)).not.toContain('devsandbox');
  });

  // Main's own dev deploy (docs/ops/CI-BOT.md → Two lanes): the one role that may enter the freeze-exempt bootstrap.
  it('trusts the dev-main role only from the main-only dev-main environment', () => {
    const [role] = Object.values(
      t.findResources('AWS::IAM::Role', { Properties: { RoleName: 'aperture-github-dev-main' } }),
    ) as {
      Properties: {
        AssumeRolePolicyDocument: {
          Statement: { Condition: Record<string, Record<string, unknown>> }[];
        };
      };
    }[];
    const subs = role?.Properties.AssumeRolePolicyDocument.Statement.map(
      (s) => s.Condition.StringLike?.['token.actions.githubusercontent.com:sub'],
    );
    expect(subs).toEqual([['repo:acme/aperture:environment:dev-main']]);
  });

  it("lets the dev-main role assume exactly the devmain bootstrap's deploy, lookup and publishing roles", () => {
    const assume = statementsOf('aperture-github-dev-main').filter(
      (s) => s.Action === 'sts:AssumeRole',
    );
    expect(assume.map((s) => s.Resource)).toEqual([
      [
        'arn:aws:iam::222222222222:role/cdk-devmain-deploy-role-222222222222-us-west-1',
        'arn:aws:iam::222222222222:role/cdk-devmain-lookup-role-222222222222-us-west-1',
        'arn:aws:iam::222222222222:role/cdk-devmain-file-publishing-role-222222222222-us-west-1',
      ],
    ]);
    expect(bootstrapGrants('aperture-github-dev-main')).toContain(
      'parameter/cdk-bootstrap/devmain/version',
    );
    expect(bootstrapGrants('aperture-github-dev-main')).not.toContain('hnb659fds');
    expect(bootstrapGrants('aperture-github-dev-main')).not.toContain('*');
  });

  it("keeps the frozen lane's role and prod's out of the devmain bootstrap", () => {
    expect(JSON.stringify(statementsOf('aperture-github-deploy-dev'))).not.toContain('devmain');
    expect(JSON.stringify(prodT.toJSON())).not.toContain('devmain');
    expect(JSON.stringify(prodT.toJSON())).not.toContain('dev-main');
  });

  it('gives the dev-main role the same dev publish, smoke and outputs grants as the dev role', () => {
    const rest = (r: string) =>
      statementsOf(r).filter(
        (s) => s.Action !== 'sts:AssumeRole' && s.Action !== 'ssm:GetParameter',
      );
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

  it("lets the logs role read only the dev slots' Lambda groups, and nothing else", () => {
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
    const groups = [...resources.matchAll(/\/aws\/lambda\/([a-z-]+):\*/g)].map((m) => m[1]).sort();
    const fns = ['bff', 'mcp', 'finance-sync', 'push-dispatch'];
    expect(groups).toEqual(
      fns.flatMap((fn) => [`aperture-${fn}-dev`, `aperture-${fn}-devb`]).sort(),
    );
    expect(resources).not.toContain('-prod');
    // Only the three id-addressed query calls sit on `*`.
    const star = stmts
      .filter((s) => s.Resource === '*')
      .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(star.sort()).toEqual(['logs:DescribeQueries', 'logs:GetQueryResults', 'logs:StopQuery']);
  });

  // One account, both slots: a devb deploy publishes, smokes and reads outputs through the same two roles.
  it('lets both dev deploy roles publish, smoke and read outputs on both dev slots, never prod', () => {
    for (const role of ['aperture-github-deploy-dev', 'aperture-github-dev-main']) {
      const grants = JSON.stringify(
        statementsOf(role).filter(
          (s) => s.Action !== 'sts:AssumeRole' && s.Action !== 'ssm:GetParameter',
        ),
      );
      for (const slot of ['dev', 'devb']) {
        expect(grants, role).toContain(`apertureapp-${slot}-*`);
        expect(grants, role).toContain(`function:aperture-bff-${slot}"`);
        expect(grants, role).toContain(`stack/ApertureData-${slot}/*`);
        expect(grants, role).toContain(`stack/ApertureApp-${slot}/*`);
      }
      expect(grants, role).not.toContain('prod');
    }
  });

  it("keeps prod's role to prod's own resources", () => {
    const grants = JSON.stringify(statementsOf('aperture-github-deploy-prod'));
    expect(grants).toContain('apertureapp-prod-*');
    expect(grants).not.toMatch(/-devb?[-/:"]/);
  });

  it('grants read-only DescribeStacks for the app-only deploy tier', () => {
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Action: 'cloudformation:DescribeStacks' })]),
      }),
    });
  });
});

// The public-repo check (INFRA §9 → Public repo): every role GitHub can assume admits only this repo's named
// environments — never a wildcard (another repo, a fork), never a pull_request subject — for both forms of the
// subject segment (the slug, and the ID-embedded `owner@id/repo@id` the live roles use, INFRA §9).
const OIDC = 'token.actions.githubusercontent.com';
const ENVIRONMENTS = { prod: ['prod'], dev: ['dev', 'dev-main', 'dev-logs'] };
interface Trust {
  Effect?: string;
  Action?: unknown;
  Principal?: { Federated?: unknown };
  Condition?: Record<string, Record<string, unknown>>;
}

// What's wrong with one trust statement for `subject` — an empty list is a statement that admits only named
// environments of this one repo.
function trustProblems(s: Trust, subject: string): string[] {
  const out: string[] = [];
  if (s.Effect !== 'Allow') out.push(`Effect ${String(s.Effect)}`);
  if (s.Action !== 'sts:AssumeRoleWithWebIdentity') out.push(`Action ${JSON.stringify(s.Action)}`);
  const ops = Object.keys(s.Condition ?? {}).sort();
  if (ops.join() !== 'StringEquals,StringLike')
    out.push(`condition operators ${ops.join() || 'none'}`);
  const aud = s.Condition?.StringEquals?.[`${OIDC}:aud`];
  if (aud !== 'sts.amazonaws.com') out.push(`aud ${JSON.stringify(aud)}`);
  const extra = Object.keys(s.Condition?.StringEquals ?? {}).filter((k) => k !== `${OIDC}:aud`);
  if (extra.length) out.push(`unexpected StringEquals keys ${extra.join()}`);
  const subKeys = Object.keys(s.Condition?.StringLike ?? {});
  if (subKeys.join() !== `${OIDC}:sub`) out.push(`StringLike keys ${subKeys.join() || 'none'}`);
  const raw = s.Condition?.StringLike?.[`${OIDC}:sub`];
  const subs = Array.isArray(raw) ? raw : [raw];
  if (!subs.length) out.push('no sub');
  const lit = subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ok = new RegExp(`^repo:${lit}:environment:(prod|dev|dev-main|dev-logs)$`);
  for (const sub of subs)
    if (
      typeof sub !== 'string' ||
      /[*?]/.test(sub) ||
      sub.includes('pull_request') ||
      !ok.test(sub)
    )
      out.push(`sub ${JSON.stringify(sub)}`);
  return out;
}

const federated = (t: Template) =>
  Object.entries(t.findResources('AWS::IAM::Role')).flatMap(([id, r]) => {
    const props = (
      r as { Properties: { RoleName?: string; AssumeRolePolicyDocument: { Statement: Trust[] } } }
    ).Properties;
    return props.AssumeRolePolicyDocument.Statement.filter(
      (s) =>
        s.Principal?.Federated !== undefined ||
        JSON.stringify(s.Action).includes('WebIdentity') ||
        JSON.stringify(s).includes(OIDC),
    ).map((s) => ({ id, name: props.RoleName ?? id, s }));
  });

describe('ApertureCicdStack OIDC trust, for a public repo', () => {
  const build = (roles: 'prod' | 'dev', githubSubject?: string) =>
    Template.fromStack(
      new ApertureCicdStack(new App(), 'Cicd', {
        env: { account: '111111111111', region: 'us-west-1' },
        githubRepo: 'acme/aperture',
        githubSubject,
        roles,
      }),
    );

  for (const roles of ['prod', 'dev'] as const)
    for (const subject of ['acme/aperture', 'acme@1/aperture@2']) {
      it(`${roles}, subject ${subject}: every federated role admits only its named environments`, () => {
        const t = build(roles, subject === 'acme/aperture' ? undefined : subject);
        const stmts = federated(t);
        // not vacuous: every aperture-github-* role is walked, and every other role (CDK's provider Lambda) trusts
        // only an AWS service
        expect(stmts.length).toBeGreaterThan(0);
        expect([...new Set(stmts.map((x) => x.name))].sort()).toEqual(
          roleNames(t).filter((n) => n?.startsWith('aperture-github-')),
        );
        const walked = new Set(stmts.map((x) => x.id));
        for (const [id, r] of Object.entries(t.findResources('AWS::IAM::Role')))
          if (!walked.has(id))
            for (const s of (
              r as {
                Properties: { AssumeRolePolicyDocument: { Statement: { Principal: object }[] } };
              }
            ).Properties.AssumeRolePolicyDocument.Statement)
              expect(Object.keys(s.Principal)).toEqual(['Service']);
        for (const { name, s } of stmts)
          expect([name, trustProblems(s, subject)]).toEqual([name, []]);
        const envs = stmts
          .flatMap(({ s }) => s.Condition!.StringLike![`${OIDC}:sub`] as string[])
          .map((sub) => sub.slice(`repo:${subject}:environment:`.length));
        expect(envs.sort()).toEqual([...ENVIRONMENTS[roles]].sort());
      });
    }

  it('the checker flags every way a trust can admit too much', () => {
    const good: Trust = {
      Effect: 'Allow',
      Action: 'sts:AssumeRoleWithWebIdentity',
      Condition: {
        StringEquals: { [`${OIDC}:aud`]: 'sts.amazonaws.com' },
        StringLike: { [`${OIDC}:sub`]: ['repo:acme/aperture:environment:prod'] },
      },
    };
    expect(trustProblems(good, 'acme/aperture')).toEqual([]);
    const withSub = (sub: unknown): Trust => ({
      ...good,
      Condition: { ...good.Condition, StringLike: { [`${OIDC}:sub`]: sub } },
    });
    for (const sub of [
      'repo:acme/aperture:*',
      'repo:acme/*:environment:prod',
      'repo:*',
      'repo:acme/aperture:pull_request',
      'repo:acme/aperture:ref:refs/heads/main',
      'repo:acme/aperture:environment:staging',
      'repo:acme/aperture-fork:environment:prod',
      'repo:acme/aperture:environment:pr?d',
    ])
      expect(trustProblems(withSub([sub]), 'acme/aperture')).toEqual([
        `sub ${JSON.stringify(sub)}`,
      ]);
    expect(trustProblems(withSub([]), 'acme/aperture')).toEqual(['no sub']);
    expect(
      trustProblems(
        { ...good, Condition: { StringLike: good.Condition!.StringLike! } },
        'acme/aperture',
      ),
    ).toEqual(['condition operators StringLike', 'aud undefined']);
    expect(
      trustProblems(
        { ...good, Condition: { ...good.Condition, StringEquals: { [`${OIDC}:aud`]: '*' } } },
        'acme/aperture',
      ),
    ).toEqual(['aud "*"']);
    expect(trustProblems({ ...good, Condition: undefined }, 'acme/aperture')).toEqual([
      'condition operators none',
      'aud undefined',
      'StringLike keys none',
      'sub undefined',
    ]);
  });

  it('refuses a githubRepo or githubSubject that StringLike would read as a pattern', () => {
    for (const [key, value] of [
      ['githubRepo', 'acme/*'],
      ['githubRepo', 'acme/aperture:ref'],
      ['githubSubject', 'acme@1/aperture@?'],
      ['githubRepo', 'aperture'],
    ] as const)
      expect(
        () =>
          new ApertureCicdStack(new App(), 'Cicd', {
            githubRepo: 'acme/aperture',
            roles: 'prod',
            [key]: value,
          }),
      ).toThrow(new RegExp(`^${key} `));
  });

  // A GitHub-trusted role anywhere else would escape the walk above, so there's one home for them.
  it('creates GitHub-federated roles only in cicd-stack.ts', () => {
    const dir = new URL('./lib/', import.meta.url);
    const holders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) =>
        readFileSync(new URL(f, dir), 'utf8')
          .split('\n')
          .filter((l) => !l.trim().startsWith('//'))
          .some((l) =>
            /token\.actions\.githubusercontent|OpenIdConnect|WebIdentity|FederatedPrincipal/.test(
              l,
            ),
          ),
      );
    expect(holders).toEqual(['cicd-stack.ts']);
  });
});
