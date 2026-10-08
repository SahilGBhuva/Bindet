import { OnboardingActions, type OnboardingStepProps } from './OnboardingParts'

/*
 * OTTO STEP SLOT. A short "Meet Otto" introduction for now.
 *
 * The Otto preferences form (what Otto should call you, and Otto's personality) is
 * being built separately. After it merges, replace the body of this component with
 * that form and keep the same props: call onNext() once the preferences are saved,
 * onSkip() to move on without saving. The setup shell (Onboarding.tsx) does not need
 * to change; the step stays optional and skippable.
 */
export function OnboardingOttoStep({ headingRef, onNext, onSkip }: OnboardingStepProps) {
  return (
    <form
      className="onb-step onb-otto"
      aria-labelledby="onb-otto-title"
      onSubmit={(event) => {
        event.preventDefault()
        onNext()
      }}
    >
      <img className="onb-otto__mascot" src="/bindit-mascot-cutout.webp" alt="" width="240" height="288" />
      <h1 className="onb-title" id="onb-otto-title" ref={headingRef} tabIndex={-1}>Meet Otto, your tutor</h1>
      <p className="onb-lead">Otto is the bindet otter. Ask about anything you’re studying and Otto walks you through it.</p>
      <ul className="onb-otto__list">
        <li>Pick a course and Otto answers from your notes first</li>
        <li>Stuck on a problem? Send Otto a photo of it</li>
        <li>Find Otto on the Tutor page any time</li>
      </ul>
      <OnboardingActions primary="Continue" onSkip={onSkip} />
    </form>
  )
}
