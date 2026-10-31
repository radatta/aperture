import { LambdaClient, UpdateFunctionUrlConfigCommand } from '@aws-sdk/client-lambda';
import { AttachPolicyCommand, OrganizationsClient } from '@aws-sdk/client-organizations';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { kill, killConfigFrom } from './kill';
import type { KillGateways } from './kill';

// The kill switch's Lambda entry (kill.ts has the logic). The three SDK clients are here for SigV4 (dependency
// rule B); they ship in the Lambda runtime, so the bundle keeps them external. Organizations is a global service
// served from us-east-1; the dev functions live in DEV_REGION, reached through the dev account's break-glass role.
const BREAK_GLASS_ROLE = 'OrganizationAccountAccessRole';

function liveGateways(devAccountId: string, devRegion: string): KillGateways {
  const orgs = new OrganizationsClient({ region: 'us-east-1' });
  const sts = new STSClient({});
  let devLambda: LambdaClient | undefined;
  const lambdaClient = async () => {
    if (devLambda) return devLambda;
    const { Credentials: c } = await sts.send(
      new AssumeRoleCommand({
        RoleArn: `arn:aws:iam::${devAccountId}:role/${BREAK_GLASS_ROLE}`,
        RoleSessionName: 'aperture-kill',
        DurationSeconds: 900,
      }),
    );
    if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error('AssumeRole returned no credentials');
    devLambda = new LambdaClient({
      region: devRegion,
      credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken },
    });
    return devLambda;
  };
  return {
    async attachPolicy(policyId, targetId) {
      try {
        await orgs.send(new AttachPolicyCommand({ PolicyId: policyId, TargetId: targetId }));
        return 'attached';
      } catch (err) {
        if (err instanceof Error && err.name === 'DuplicatePolicyAttachmentException') return 'already';
        throw err;
      }
    },
    async lockFunctionUrl(functionName) {
      await (await lambdaClient()).send(new UpdateFunctionUrlConfigCommand({ FunctionName: functionName, AuthType: 'AWS_IAM' }));
    },
  };
}

// Any trigger kills: the EventBridge rule only forwards ALARM transitions, and the budget topic only fires past the
// kill threshold. The event is logged for the record and otherwise ignored.
export const handler = async (event: unknown): Promise<void> => {
  const cfg = killConfigFrom(process.env);
  console.log(`kill triggered: ${JSON.stringify(event).slice(0, 2000)}`);
  await kill(cfg, liveGateways(cfg.devAccountId, process.env.DEV_REGION ?? 'us-west-1'), (l) => console.log(l));
};
