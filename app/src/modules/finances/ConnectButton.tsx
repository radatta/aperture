import type { PlaidEnvironment } from '@aperture/shared';
import { Button } from '../../components/Button';
import type { useBankLink } from './useBankLink';
import { isStandalonePwa } from './usePlaidLink';

// Connect a (new) bank. Inside an installed PWA it's a link that opens /finances?link=connect in a
// normal browser tab, where the page starts Link on load (see isStandalonePwa for why).
export function ConnectButton({
  environment,
  link,
  label = 'Connect a bank',
  variant = 'primary',
}: {
  environment: PlaidEnvironment;
  link: ReturnType<typeof useBankLink>;
  label?: string;
  variant?: 'primary' | 'quiet';
}) {
  if (environment !== 'stub' && isStandalonePwa())
    return (
      <a
        href="/finances?link=connect"
        target="_blank"
        rel="noopener"
        className="text-sm text-teal underline-offset-2 hover:underline"
      >
        {label} (opens in browser)
      </a>
    );
  return (
    <Button
      size="sm"
      variant={variant}
      disabled={link.busy}
      onClick={() => link.start({ mode: 'connect' })}
    >
      {link.busy ? 'Connecting…' : label}
    </Button>
  );
}
