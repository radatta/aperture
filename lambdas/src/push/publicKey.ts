import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

// The BFF's half of the VAPID pair: the public key (a String parameter, not a secret — it is the
// browser's applicationServerKey) from `/aperture/<stage>/push/vapid_public_key`. The BFF never reads the
// private one; its IAM names this parameter only. Held for a few minutes per container, so a rotation
// (reminders.md → D12) reaches Settings without a recycle. null = this stage isn't set up.

const CACHE_MS = 10 * 60_000;

type SsmLike = Pick<SSMClient, 'send'>;
export type PublicKeyReader = () => Promise<string | null>;

export const noPublicKey: PublicKeyReader = async () => null;

export function createPublicKeyReader(cfg: {
  stage: string;
  ssm?: SsmLike;
  now?: () => number;
}): PublicKeyReader {
  const ssm: SsmLike = cfg.ssm ?? new SSMClient({});
  const now = cfg.now ?? Date.now;
  const name = `/aperture/${cfg.stage}/push/vapid_public_key`;
  let cached: { value: string; at: number } | null = null;
  return async () => {
    if (cached && now() - cached.at < CACHE_MS) return cached.value;
    try {
      const res = await ssm.send(new GetParameterCommand({ Name: name }));
      const value = res.Parameter?.Value?.trim() || null; // a pasted newline is no part of the key
      cached = value ? { value, at: now() } : null;
      return value;
    } catch (err) {
      if (err instanceof Error && err.name === 'ParameterNotFound') {
        cached = null;
        return null;
      }
      throw err;
    }
  };
}
