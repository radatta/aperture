import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { FinanceSyncInvoker } from './invoker';

type LambdaLike = Pick<LambdaClient, 'send'>;

// Starts the sync Lambda asynchronously (InvocationType 'Event'): Lambda queues it and answers 202 at
// once, so the RPC returns while the sync runs. Lambda retries a failed async run twice on its own —
// harmless, the sync is idempotent and locked. `@aws-sdk/client-lambda` is here for SigV4 (dependency
// rule B); it ships in the Lambda runtime, so the bundle keeps it external.
export function liveInvoker(
  functionName: string,
  client: LambdaLike = new LambdaClient({}),
): FinanceSyncInvoker {
  return {
    async invoke(e) {
      const res = await client.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: 'Event',
          Payload: new TextEncoder().encode(JSON.stringify(e)),
        }),
      );
      if (res.StatusCode !== 202)
        throw new Error(`Couldn’t start the sync (${res.StatusCode ?? '?'})`);
    },
  };
}
