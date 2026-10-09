/*
 * Opens the help panel from elsewhere in the app (the phone Menu sheet's "Help" row),
 * without importing the help bot itself.
 */
export const OPEN_HELP_EVENT = 'bindet:open-help'

export function openHelp() {
  window.dispatchEvent(new Event(OPEN_HELP_EVENT))
}
