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
