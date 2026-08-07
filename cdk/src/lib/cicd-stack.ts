import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface CicdStackProps extends StackProps {
  githubRepo: string; // 'owner/repo' — drives the OIDC trust subject
}

const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';
const GITHUB_OIDC_URL = `https://${GITHUB_OIDC_HOST}`;
const CDK_QUALIFIER = 'hnb659fds'; // default bootstrap qualifier (cdk-hnb659fds-*-role)

// Deployed ONCE, by hand, before CI can run — chicken-and-egg: the roles must exist for GitHub to assume
// them. Creates the GitHub OIDC provider + two keyless deploy roles, then the pipeline never touches it.
// The roles hold almost no direct power: cdk deploy is funneled through the account's CDK bootstrap roles
// (they carry the real permissions), and the roles get only the handful of direct actions the frontend
// publish + smoke step take outside CloudFormation. Prod trust is bound to the `prod` GitHub environment,
// so prod credentials are unassumable until the environment's approval gate passes.
export class ApertureCicdStack extends Stack {
  constructor(scope: Construct, id: string, props: CicdStackProps) {
    super(scope, id, props);
    const { githubRepo } = props;
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
      return role;
    };

    // dev: branch-based (a `dev` push, or the `main` pipeline's dev stage which runs from the main ref).
    const devRole = makeRole(
      'DeployDev',
      'aperture-github-deploy-dev',
      [`repo:${githubRepo}:ref:refs/heads/dev`, `repo:${githubRepo}:ref:refs/heads/main`],
      'dev',
    );
    // prod: environment-based — only a job running in the approval-gated `prod` environment gets this sub.
    const prodRole = makeRole(
      'DeployProd',
      'aperture-github-deploy-prod',
      [`repo:${githubRepo}:environment:prod`],
      'prod',
    );

    new CfnOutput(this, 'DevRoleArn', { value: devRole.roleArn });
    new CfnOutput(this, 'ProdRoleArn', { value: prodRole.roleArn });
  }
}
