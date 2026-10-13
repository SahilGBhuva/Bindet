import re
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

import auth
from disposable_email import DISPOSABLE_DOMAINS, is_disposable


class DisposableEmailTests(unittest.TestCase):
    def test_throwaway_services_are_caught(self):
        for email in ('kid@10minutemail.com', 'A@Mailinator.com', 'x@temp-mail.org', 'y@mx.guerrillamail.com', 'z@yopmail.com.'):
            self.assertTrue(is_disposable(email), email)

    def test_real_providers_and_schools_pass(self):
        for email in ('student@gmail.com', 'me@outlook.com', 'kid@icloud.com', 'a@school.k12.ca.us', 'b@proton.me', '', None, 'no-at-sign'):
            self.assertFalse(is_disposable(email), email)

    def test_frontend_list_matches(self):
        source = (Path(__file__).resolve().parent.parent / 'frontend/src/lib/disposableEmail.ts').read_text()
        listed = set(re.findall(r"'([a-z0-9.-]+\.[a-z]{2,})'", source.split('])', 1)[0]))
        self.assertEqual(listed, set(DISPOSABLE_DOMAINS))

    def test_disposable_account_is_refused_but_may_delete_itself(self):
        user = {'id': 'u1', 'email': 'kid@10minutemail.com', 'email_confirmed_at': '2026-10-01T00:00:00Z'}
        response = mock.Mock(status_code=200, json=lambda: user)
        with mock.patch.object(auth, 'public_settings', return_value=('https://example.supabase.co', 'anon')), \
             mock.patch.object(auth.httpx, 'get', return_value=response):
            auth._verify_cache.clear()
            with self.assertRaises(HTTPException) as caught:
                auth.authenticated_user('Bearer disposable-token')
            self.assertEqual(caught.exception.status_code, 403)
            self.assertEqual(caught.exception.detail['code'], 'email_disposable')
            self.assertEqual(auth.authenticated_user('Bearer disposable-token', allow_disposable=True)['id'], 'u1')


if __name__ == '__main__':
    unittest.main()
