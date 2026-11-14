// The repo's public identifiers, from identifiers.json at the root (docs/ops/IDENTIFIERS.md) — read at synth, never
// imported (it sits outside rootDir). Only what CDK uses: the stage domains and where alerts land.
import { readFileSync } from 'node:fs';

interface CdkIdentifiers {
  email: { alerts: string };
  domains: { prod: string; dev: string; devb: string };
}

const IDS = JSON.parse(
  readFileSync(new URL('../../../identifiers.json', import.meta.url), 'utf8'),
) as CdkIdentifiers;

// Where prod alarms, cost alerts and the dev kill switch's mail land: the maintainer's own inbox, by design.
export const ALERT_EMAIL = IDS.email.alerts;
export const STAGE_DOMAINS: Readonly<Record<string, string>> = {
  dev: IDS.domains.dev,
  devb: IDS.domains.devb,
  prod: IDS.domains.prod,
};
