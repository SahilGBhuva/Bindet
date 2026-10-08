import { OttoPreferencesCompact } from '../otto/OttoPreferences'
import type { OnboardingStepProps } from './OnboardingParts'

/*
 * Step 3: meet Otto, and (optionally) tell Otto what to call you and how to talk.
 * The form saves on its own; saving moves on. Continue moves on without saving, so the
 * step stays optional. The form is its own <form>, so this step is a plain section.
 */
export function OnboardingOttoStep({ headingRef, onNext, onSkip, token, defaultName }: OnboardingStepProps & { token: string; defaultName: string }) {
  return (
    <section className="onb-step onb-otto" aria-labelledby="onb-otto-title">
      <img className="onb-otto__mascot" src="/bindit-mascot-cutout.webp" alt="" width="240" height="288" />
      <h1 className="onb-title" id="onb-otto-title" ref={headingRef} tabIndex={-1}>Meet Otto, your tutor</h1>
      <p className="onb-lead">Otto is the bindet otter. Ask about anything you’re studying and Otto answers from your notes first. Make Otto yours, or skip this.</p>
      <OttoPreferencesCompact token={token} defaultName={defaultName} onSaved={() => onNext()} />
      <div className="onb-actions">
        <button type="button" className="ui-button ui-button--ghost onb-actions__skip" onClick={onSkip}>Skip</button>
        <button type="button" className="ui-button onb-actions__next" onClick={onNext}>Continue without saving</button>
      </div>
    </section>
  )
}
