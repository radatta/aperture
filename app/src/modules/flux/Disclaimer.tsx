import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ShieldCheckIcon } from '../../components/icons';
import { Text } from '../../components/Text';

// First-run, non-medical-device acknowledgement. Gates every Flux screen until accepted; the
// acknowledgement is a Settings field (synced), resettable from Settings → Flux. Copy is flux-track's,
// except the privacy line: set results are saved to your account for history, so "no data ever leaves" would
// be false.
export function Disclaimer({ onAccept, busy }: { onAccept: () => void; busy?: boolean }) {
  return (
    <Card className="flex flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-teal-soft text-teal">
          <ShieldCheckIcon size={24} />
        </span>
        <Text as="h2" size="xl" weight="semibold">
          Before you start
        </Text>
      </div>
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-ink">
        <p>
          Flux is a personal movement guide, <b>not a medical device</b> and not a substitute for a
          clinician. Webcam head-tracking is accurate <i>relatively</i> — it shows your own trends
          from a per-session neutral, not clinical-grade angles.
        </p>
        <p>
          Move only within a comfortable, pain-free range. <b>Stop</b> if an exercise causes sharp
          pain, pain spreading down the arm, numbness, tingling, or dizziness — and check with a
          professional before continuing.
        </p>
        <p className="text-ink-muted">
          Tracking runs on your device and no video ever leaves it. Only set results — counts and
          angles — are ever saved to your account.
        </p>
      </div>
      <Button
        className="w-full"
        onClick={busy ? undefined : onAccept}
        aria-disabled={busy || undefined}
      >
        I understand — continue
      </Button>
    </Card>
  );
}

export function DisclaimerFooter() {
  return (
    <Text as="p" size="xs" tone="muted" className="mt-6 text-center">
      Not a medical device. For guidance only — stop and seek care if symptoms worsen. Tracking runs
      on-device.
    </Text>
  );
}
