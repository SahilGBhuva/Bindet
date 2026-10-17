"""One SQLite database for the whole pytest session.

``database.engine()`` is cached for the life of the process, so every test
module has to agree on a single ``POCKET_TUTOR_DB_PATH``. This file is imported
before any test module, so the modules' own ``os.environ.setdefault`` calls
keep this path, and their teardown only removes their own unused temp file.
"""
import os
import tempfile

_SESSION_DB = tempfile.NamedTemporaryFile(prefix="bindet-tests-", suffix=".db", delete=False)
_SESSION_DB.close()
os.environ["POCKET_TUTOR_DB_PATH"] = _SESSION_DB.name


def pytest_sessionfinish(session, exitstatus):
    try:
        os.unlink(_SESSION_DB.name)
    except OSError:
        pass


import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _rewards_only_where_tested(request):
    """Daily quests are picked per student and day, so their small bonus XP would make the
    XP totals older tests assert depend on the date (and on test order, since a day's quests
    are stored). The reward systems run in test_rewards.py; elsewhere rewards.record() is a
    no-op, while the routes still call it."""
    if request.module.__name__ == "test_rewards":
        yield
        return
    from unittest.mock import patch
    import rewards
    with patch.object(rewards, "_record", return_value=None):
        yield
