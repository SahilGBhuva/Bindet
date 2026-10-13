// Throwaway inbox services (10-minute mail and the like) that can't be used for a bindet
// account. The server refuses them too (backend/disposable_email.py, kept in step by
// backend/test_disposable_email.py); this copy lets sign-up say so before an account is made.
const DISPOSABLE_DOMAINS = new Set([
  '027168.com', '10mail.org', '10minemail.com', '10minutemail.co.uk', '10minutemail.com', '10minutemail.de',
  '10minutemail.net', '10minutemail.org', '10minutesmail.com', '1secmail.com', '1secmail.net', '1secmail.org',
  '20minutemail.com', '20minutemail.it', '30minutemail.com', '33mail.com', 'anonbox.net', 'anonymbox.com',
  'armyspy.com', 'bugfoo.com', 'burnermail.io', 'byom.de', 'cetnob.com', 'chacuo.net',
  'cuvox.de', 'dayrep.com', 'deadaddress.com', 'discard.email', 'discardmail.com', 'discardmail.de',
  'disposable.email', 'disposableemailaddresses.com', 'disposableinbox.com', 'dispostable.com', 'dropmail.me', 'einrot.com',
  'email-fake.com', 'emailfake.com', 'emailnax.com', 'emailondeck.com', 'emailtemporanea.com', 'emailtemporanea.net',
  'emltmp.com', 'ezztt.com', 'fakeinbox.com', 'fakemail.net', 'fakemailgenerator.com', 'fleckens.hu',
  'getairmail.com', 'getnada.com', 'gishpuppy.com', 'grr.la', 'guerrillamail.biz', 'guerrillamail.com',
  'guerrillamail.de', 'guerrillamail.info', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com', 'gustr.com',
  'harakirimail.com', 'hexi.pics', 'hide.biz.st', 'inboxbear.com', 'inboxkitten.com', 'incognitomail.org',
  'jetable.org', 'jourrapide.com', 'kloap.com', 'kurzepost.de', 'linshiyouxiang.net', 'luxusmail.org',
  'mail-temp.com', 'mail.tm', 'mail7.io', 'mailcatch.com', 'maildrop.cc', 'mailexpire.com',
  'mailforspam.com', 'mailinator.com', 'mailinator.net', 'mailinator.org', 'mailinator2.com', 'mailnesia.com',
  'mailnull.com', 'mailpoof.com', 'mailsac.com', 'mailslurp.com', 'mailtemp.net', 'meltmail.com',
  'mintemail.com', 'moakt.com', 'mohmal.com', 'mt2015.com', 'mvrht.com', 'mytemp.email',
  'mytrashmail.com', 'nada.email', 'nwytg.net', 'one-time.email', 'oneoffemail.com', 'owlymail.com',
  'pokemail.net', 'rhyta.com', 'rootfest.net', 'sharklasers.com', 'shitmail.me', 'smashmail.de',
  'snapmail.cc', 'spam4.me', 'spambog.com', 'spambox.us', 'spamex.com', 'spamfree24.org',
  'spamgourmet.com', 'spaml.com', 'spamspot.com', 'superrito.com', 'teleworm.us', 'temp-mail.io',
  'temp-mail.org', 'temp-mail.ru', 'tempail.com', 'tempemail.co', 'tempemail.com', 'tempemail.net',
  'tempinbox.com', 'tempm.com', 'tempmail.com', 'tempmail.de', 'tempmail.dev', 'tempmail.net',
  'tempmail.plus', 'tempmailaddress.com', 'tempmailo.com', 'temporaryemail.net', 'temporaryinbox.com', 'tempr.email',
  'thankyou2010.com', 'throwam.com', 'throwawaymail.com', 'tmail.ws', 'tmailor.com', 'tmails.net',
  'tmpbox.net', 'tmpmail.net', 'tmpmail.org', 'trash-mail.com', 'trashmail.at', 'trashmail.com',
  'trashmail.de', 'trashmail.io', 'trashmail.me', 'trashmail.net', 'trashmail.ws', 'trbvm.com',
  'vintomaper.com', 'vomoto.com', 'wegwerfmail.de', 'wegwerfmail.net', 'wegwerfmail.org', 'wireconnected.com',
  'yomail.info', 'yopmail.com', 'yopmail.fr', 'yopmail.net', 'zetmail.com', 'zippymail.info',
])

export const DISPOSABLE_EMAIL_MESSAGE = 'bindet doesn’t work with temporary email addresses. Sign up with your school or personal email.'

/** True for an address at a throwaway inbox service (or any subdomain of one). */
export function isDisposableEmail(email: string) {
  const at = email.lastIndexOf('@')
  if (at < 0) return false
  const parts = email.slice(at + 1).trim().toLowerCase().replace(/\.+$/, '').split('.')
  return parts.some((_, index) => index < parts.length - 1 && DISPOSABLE_DOMAINS.has(parts.slice(index).join('.')))
}
