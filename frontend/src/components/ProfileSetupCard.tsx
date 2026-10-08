/*
 * Shown to a signed-in account that has no bindet profile yet (the name step of the welcome
 * setup was skipped, for example): until a name and username are saved there is no friend
 * ID and nobody can find them, so point to Settings instead of showing signed-out copy.
 */
export function ProfileSetupCard({ className = '' }: { className?: string }) {
  return (
    <div className={`ui-alert ui-alert--info profile-setup-card${className ? ` ${className}` : ''}`} role="status">
      <span>
        <strong>Finish setting up your profile.</strong> Choose your name and username so friends can find you and you get a friend ID to share.
      </span>
      <a className="ui-button ui-button--primary ui-button--sm" href="#settings">Set up profile</a>
    </div>
  )
}
