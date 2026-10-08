import type { Ref } from 'react'

/* What every setup step receives. A step renders its own form and calls onNext when done. */
export type OnboardingStepProps = {
  /** Put on the step's heading: the shell moves focus there when the step opens. */
  headingRef: Ref<HTMLHeadingElement>
  onNext: () => void
  onSkip: () => void
}

/* The step's buttons: Skip on the left, the one primary action on the right. */
export function OnboardingActions({ primary, onSkip, busy = false, skipLabel = 'Skip' }: { primary: string; onSkip: () => void; busy?: boolean; skipLabel?: string }) {
  return (
    <div className="onb-actions">
      <button className="ui-button ui-button--ghost onb-actions__skip" type="button" onClick={onSkip} disabled={busy}>{skipLabel}</button>
      <button className={`ui-button ui-button--primary onb-actions__next${busy ? ' is-busy' : ''}`} type="submit" disabled={busy} aria-busy={busy || undefined}>{primary}</button>
    </div>
  )
}
