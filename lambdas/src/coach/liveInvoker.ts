import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { CoachPickInvoker } from './invoker';

type LambdaLike = Pick<LambdaClient, 'send'>;

// Starts the coach worker asynchronously (InvocationType 'Event'): Lambda queues it and answers 202 at once. Never
// retried (retryAttempts 0, cdk coach-worker): the day gets one call, and a dropped event reads as a timeout after
// AI_PICK_STALE_MS. The name comes from COACH_WORKER_FN; none → the invoker is disabled (index.ts, mcp/index.ts).
export function livePickInvoker(
  functionName: string,
  client: LambdaLike = new LambdaClient({}),
): CoachPickInvoker {
  return {
    enabled: true,
    async invoke(e) {
      const res = await client.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: 'Event',
          Payload: new TextEncoder().encode(JSON.stringify(e)),
        }),
      );
      if (res.StatusCode !== 202)
        throw new Error(`Couldn’t start the AI pick (${res.StatusCode ?? '?'})`);
    },
  };
}
