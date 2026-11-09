import {
  CloudFrontClient,
  GetDistributionConfigCommand,
  ListDistributionsCommand,
  UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import type { DistributionConfig } from '@aws-sdk/client-cloudfront';
import {
  LambdaClient,
  ListFunctionsCommand,
  PutFunctionConcurrencyCommand,
  UpdateFunctionUrlConfigCommand,
} from '@aws-sdk/client-lambda';
import { AttachPolicyCommand, OrganizationsClient } from '@aws-sdk/client-organizations';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import {
  isAlreadyAttached,
  isRestore,
  kill,
  killConfigFrom,
  restore,
  setDistributionsEnabled,
} from './kill';
import type { KillConfig, KillGateways } from './kill';

// The kill switch's Lambda entry (kill.ts has the logic). The SDK clients are here for SigV4 (dependency rule B);
// they ship in the Lambda runtime, so the bundle keeps them external. Organizations and CloudFront are global
// services served from us-east-1; every dev-side call goes through the dev account's break-glass role, the one
// principal the kill SCP exempts.
function liveGateways(cfg: KillConfig): KillGateways {
  const orgs = new OrganizationsClient({ region: 'us-east-1' });
  let dev: Promise<{ lambda: LambdaClient; cloudfront: CloudFrontClient }> | undefined;
  const devClients = () =>
    (dev ??= (async () => {
      const { Credentials: c } = await new STSClient({}).send(
        new AssumeRoleCommand({
          RoleArn: cfg.breakGlassRoleArn,
          RoleSessionName: 'aperture-kill',
          DurationSeconds: 900,
        }),
      );
      if (!c?.AccessKeyId || !c.SecretAccessKey)
        throw new Error('AssumeRole returned no credentials');
      const credentials = {
        accessKeyId: c.AccessKeyId,
        secretAccessKey: c.SecretAccessKey,
        sessionToken: c.SessionToken,
      };
      return {
        lambda: new LambdaClient({ region: cfg.devRegion, credentials }),
        cloudfront: new CloudFrontClient({ region: 'us-east-1', credentials }),
      };
    })());
  return {
    async attachPolicy(policyId, targetId) {
      try {
        await orgs.send(new AttachPolicyCommand({ PolicyId: policyId, TargetId: targetId }));
        return 'attached';
      } catch (err) {
        if (isAlreadyAttached(err)) return 'already';
        throw err;
      }
    },
    async listFunctions() {
      const { lambda } = await devClients();
      const names: string[] = [];
      let Marker: string | undefined;
      do {
        const page = await lambda.send(new ListFunctionsCommand({ Marker }));
        names.push(...(page.Functions ?? []).map((f) => f.FunctionName ?? '').filter(Boolean));
        Marker = page.NextMarker;
      } while (Marker);
      return names;
    },
    async setConcurrency(FunctionName, value) {
      const { lambda } = await devClients();
      await lambda.send(
        new PutFunctionConcurrencyCommand({ FunctionName, ReservedConcurrentExecutions: value }),
      );
    },
    async setUrlAuth(FunctionName, AuthType) {
      const { lambda } = await devClients();
      await lambda.send(new UpdateFunctionUrlConfigCommand({ FunctionName, AuthType }));
    },
    async setDistributionsEnabled(enabled) {
      const { cloudfront } = await devClients();
      return setDistributionsEnabled(
        {
          async list(Marker) {
            const { DistributionList: l } = await cloudfront.send(
              new ListDistributionsCommand({ Marker }),
            );
            return {
              items: (l?.Items ?? []).flatMap((d) =>
                d.Id ? [{ id: d.Id, enabled: d.Enabled === true }] : [],
              ),
              next: l?.IsTruncated ? l.NextMarker : undefined,
            };
          },
          async getConfig(Id) {
            const r = await cloudfront.send(new GetDistributionConfigCommand({ Id }));
            return {
              config: r.DistributionConfig as Record<string, unknown> | undefined,
              etag: r.ETag,
            };
          },
          async update(Id, IfMatch, config) {
            await cloudfront.send(
              new UpdateDistributionCommand({
                Id,
                IfMatch,
                DistributionConfig: config as unknown as DistributionConfig,
              }),
            );
          },
        },
        enabled,
      );
    },
  };
}

export const handler = async (event: unknown): Promise<void> => {
  const cfg = killConfigFrom(process.env);
  // A literal label: the bundle is minified, so a function's own name would log as a single letter.
  const [label, run] = isRestore(event)
    ? (['restore', restore] as const)
    : (['kill', kill] as const);
  console.log(`${label} triggered: ${JSON.stringify(event).slice(0, 2000)}`);
  await run(cfg, liveGateways(cfg), (l) => console.log(l));
};
