import { LIVE_ASSERTIVE_ID, LIVE_POLITE_ID } from '../lib/announce'

/* The always-mounted live regions announce() writes into (see lib/announce.ts). Empty and invisible. */
export function LiveAnnouncer() {
  return (
    <>
      <div id={LIVE_POLITE_ID} className="sr-only" role="status" aria-live="polite" aria-atomic="true" />
      <div id={LIVE_ASSERTIVE_ID} className="sr-only" role="alert" aria-live="assertive" aria-atomic="true" />
    </>
  )
}
