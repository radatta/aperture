// Custom-domain config per stage (Phase 14 / INFRA §8). Domain names are safe to commit; the ACM cert
// ARN embeds the account id, so it's read from the environment (APERTURE_CERT_ARN) — a GitHub var per
// stage in CI, or a local export — mirroring stageSecret's (config/ciSecrets.ts) "nothing account-specific committed" rule.
// The cert must live in us-east-1 (CloudFront's rule) even though the stacks deploy to us-west-1; we only
// reference it by ARN, so the region split is a non-issue.

import { STAGE_DOMAINS } from './identifiers';

export interface DomainConfig {
  domainName: string;
  certificateArn: string;
}

// undefined until BOTH the stage's domain name and a cert ARN are known — the app stack then stays on the
// CloudFront default domain (no alias), so deploys keep working before the domain step is finished.
export function domainConfigFor(stage: string): DomainConfig | undefined {
  const domainName = STAGE_DOMAINS[stage];
  const certificateArn = process.env.APERTURE_CERT_ARN?.trim();
  if (!domainName || !certificateArn) return undefined;
  return { domainName, certificateArn };
}
