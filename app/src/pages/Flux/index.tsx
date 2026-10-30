import { useCallback, useRef } from 'react';
import { Outlet } from 'react-router';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { useSettings, useUpdateSettings } from '../../data/hooks/useSettings';
import { useFocusRescue } from '../../lib/useFocusRescue';
import { Disclaimer, DisclaimerFooter } from '../../modules/flux/Disclaimer';
import { useFluxOutboxFlush } from '../../modules/flux/useFluxOutbox';

// Flux (docs/areas/flux): flux-track-2's webcam neck rehab, as an Aperture page. The layout holds the
// disclaimer gate (accepted once, synced via Settings) and the shared footer; the library and each
// exercise's stage are child routes, so an exercise is a deep link and Back works.
export function FluxPage() {
  const { data: settings, isPending, isError } = useSettings();
  const update = useUpdateSettings();
  useFluxOutboxFlush(); // sets a closed app or a dropped connection left queued (D49)
  const pageRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLElement>(null);
  useFocusRescue(
    pageRef,
    useCallback(() => headingRef.current, []),
  );

  return (
    <div ref={pageRef} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Text
          as="h1"
          ref={headingRef}
          tabIndex={-1}
          size="2xl"
          weight="semibold"
          className="outline-none"
        >
          Flux
        </Text>
        <Text as="p" size="sm" tone="muted">
          Guided neck exercises with live range-of-motion feedback — tracking runs on-device.
        </Text>
      </div>
      {!settings ? (
        <EmptyState pending={isPending} error={isError} title="" />
      ) : settings.fluxDisclaimerAckAt === null ? (
        <>
          <Disclaimer
            busy={update.isPending}
            onAccept={() => update.mutate({ fluxDisclaimerAckAt: Date.now() })}
          />
          {update.isError && (
            <p role="alert" className="text-sm text-danger">
              Couldn&apos;t save that — check your connection and try again.
            </p>
          )}
        </>
      ) : (
        <Outlet />
      )}
      <DisclaimerFooter />
    </div>
  );
}
