import {
  CloudFrontClient,
  GetDistributionConfigCommand,
  ListDistributionsCommand,
  UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import {
  DeleteFunctionConcurrencyCommand,
  LambdaClient,
  ListFunctionsCommand,
  PutFunctionConcurrencyCommand,
  UpdateFunctionUrlConfigCommand,
} from '@aws-sdk/client-lambda';
import { AttachPolicyCommand, OrganizationsClient } from '@aws-sdk/client-organizations';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { isAlreadyAttached, isRestore, kill, killConfigFrom, restore } from './kill';
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
      if (value === null) await lambda.send(new DeleteFunctionConcurrencyCommand({ FunctionName }));
      else
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
      const changed: string[] = [];
      let Marker: string | undefined;
      do {
        const page = await cloudfront.send(new ListDistributionsCommand({ Marker }));
        for (const d of page.DistributionList?.Items ?? []) {
          if (!d.Id || d.Enabled === enabled) continue;
          const { DistributionConfig, ETag } = await cloudfront.send(
            new GetDistributionConfigCommand({ Id: d.Id }),
          );
          if (!DistributionConfig) continue;
          await cloudfront.send(
            new UpdateDistributionCommand({
              Id: d.Id,
              IfMatch: ETag,
              DistributionConfig: { ...DistributionConfig, Enabled: enabled },
            }),
          );
          changed.push(d.Id);
        }
        Marker = page.DistributionList?.IsTruncated ? page.DistributionList.NextMarker : undefined;
      } while (Marker);
      return changed;
    },
  };
}

export const handler = async (event: unknown): Promise<void> => {
  const cfg = killConfigFrom(process.env);
  const run = isRestore(event) ? restore : kill;
  console.log(`${run.name} triggered: ${JSON.stringify(event).slice(0, 2000)}`);
  await run(cfg, liveGateways(cfg), (l) => console.log(l));
};
