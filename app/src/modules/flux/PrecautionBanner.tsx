import { CONDITION_LABELS, type Contraindication } from '@aperture/shared/flux';
import { Button } from '../../components/Button';
import { InfoIcon, WarningIcon } from '../../components/icons';

// Safety surface for the selected exercise: a danger box for a contraindication (with an "I understand"
// gate), a gold one for general precautions. We warn — never hide — so the user keeps agency.
export function PrecautionBanner({
  precautions,
  contraindication,
  acknowledged,
  onAcknowledge,
}: {
  precautions?: readonly string[];
  contraindication: Contraindication | null;
  acknowledged: boolean;
  onAcknowledge: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {contraindication && (
        <div className="rounded-xl border border-danger/40 bg-panel p-3">
          <div className="flex items-start gap-2 text-sm text-ink">
            <WarningIcon className="mt-0.5 shrink-0 text-danger" />
            <p>
              <span className="font-semibold text-danger">
                Caution for {CONDITION_LABELS[contraindication.condition]} ({contraindication.stage}
                ):
              </span>{' '}
              {contraindication.reason}
            </p>
          </div>
          {!acknowledged && (
            <Button variant="ghost" size="sm" className="mt-2" onClick={onAcknowledge}>
              I understand — let me continue
            </Button>
          )}
        </div>
      )}
      {precautions && precautions.length > 0 && (
        <div className="rounded-xl bg-gold-soft p-3">
          <div className="flex items-start gap-2">
            <InfoIcon className="mt-0.5 shrink-0 text-gold" />
            <ul className="flex flex-col gap-1 text-sm text-ink">
              {precautions.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
