"""Throwaway inbox services (10-minute mail and the like) that can't be used for a bindet account.

The same list lives in frontend/src/lib/disposableEmail.ts so sign-up can say so at once;
test_disposable_email.py keeps the two in step. A domain also covers its subdomains.
"""
from __future__ import annotations

DISPOSABLE_DOMAINS = frozenset({
    '10minemail.com', '10minutemail.co.uk', '10minutemail.com', '10minutemail.de', '10minutemail.net',
    '10minutemail.org', '10minutesmail.com', '10mail.org', '20minutemail.com', '20minutemail.it',
    '30minutemail.com', '33mail.com', '1secmail.com', '1secmail.net', '1secmail.org',
    'anonbox.net', 'anonymbox.com', 'armyspy.com', 'burnermail.io', 'byom.de',
    'cuvox.de', 'dayrep.com', 'deadaddress.com', 'discard.email',
    'discardmail.com', 'discardmail.de', 'disposable.email', 'disposableemailaddresses.com', 'disposableinbox.com',
    'dispostable.com', 'dropmail.me', 'einrot.com', 'email-fake.com', 'emailfake.com',
    'emailondeck.com', 'emailtemporanea.com', 'emailtemporanea.net', 'emltmp.com', 'fakeinbox.com',
    'fakemail.net', 'fakemailgenerator.com', 'fleckens.hu', 'getairmail.com',
    'getnada.com', 'gishpuppy.com', 'grr.la', 'guerrillamail.biz', 'guerrillamail.com',
    'guerrillamail.de', 'guerrillamail.info', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com',
    'gustr.com', 'harakirimail.com', 'hide.biz.st', 'incognitomail.org', 'inboxbear.com',
    'inboxkitten.com', 'jetable.org', 'jourrapide.com', 'kurzepost.de', 'linshiyouxiang.net',
    'mail-temp.com', 'mail.tm', 'mail7.io', 'mailcatch.com', 'maildrop.cc',
    'mailexpire.com', 'mailforspam.com', 'mailinator.com', 'mailinator.net', 'mailinator.org',
    'mailinator2.com', 'mailnesia.com', 'mailnull.com', 'mailpoof.com', 'mailsac.com',
    'mailslurp.com', 'mailtemp.net', 'meltmail.com', 'mintemail.com', 'mohmal.com',
    'moakt.com', 'mt2015.com', 'mvrht.com', 'mytemp.email', 'mytrashmail.com',
    'nada.email', 'nwytg.net', 'one-time.email', 'oneoffemail.com', 'owlymail.com',
    'pokemail.net', 'rhyta.com', 'rootfest.net', 'sharklasers.com', 'shitmail.me',
    'smashmail.de', 'snapmail.cc', 'spam4.me', 'spambog.com', 'spambox.us',
    'spamgourmet.com', 'spamex.com', 'spamfree24.org', 'spaml.com', 'spamspot.com',
    'superrito.com', 'teleworm.us', 'temp-mail.io', 'temp-mail.org', 'temp-mail.ru',
    'tempail.com', 'tempemail.co', 'tempemail.com', 'tempemail.net', 'tempinbox.com',
    'tempm.com', 'tempmail.com', 'tempmail.de', 'tempmail.dev', 'tempmail.net',
    'tempmail.plus', 'tempmailaddress.com', 'tempmailo.com', 'tempr.email', 'temporaryemail.net',
    'temporaryinbox.com', 'thankyou2010.com', 'throwam.com', 'throwawaymail.com', 'tmail.ws',
    'tmailor.com', 'tmpbox.net', 'tmpmail.net', 'tmpmail.org', 'trash-mail.com',
    'trashmail.at', 'trashmail.com', 'trashmail.de', 'trashmail.io', 'trashmail.me',
    'trashmail.net', 'trashmail.ws', 'trbvm.com', 'vomoto.com', 'wegwerfmail.de',
    'wegwerfmail.net', 'wegwerfmail.org', 'yopmail.com', 'yopmail.fr', 'yopmail.net',
    'zetmail.com', 'zippymail.info', 'ezztt.com', 'vintomaper.com', 'cetnob.com',
    'wireconnected.com', 'yomail.info', 'luxusmail.org', 'tmails.net', 'emailnax.com',
    'chacuo.net', '027168.com', 'bugfoo.com', 'kloap.com', 'hexi.pics',
})


def email_domain(email: str | None) -> str:
    return (email or '').strip().lower().rsplit('@', 1)[-1] if '@' in (email or '') else ''


def is_disposable(email: str | None) -> bool:
    """True for an address at a throwaway inbox service (or any subdomain of one)."""
    domain = email_domain(email).rstrip('.')
    if not domain:
        return False
    parts = domain.split('.')
    return any('.'.join(parts[i:]) in DISPOSABLE_DOMAINS for i in range(len(parts) - 1))
