"""Plans: every account is Free unless the owner has granted its email a plan.

Grants live in account_plans, keyed by the normalized inbox (disposable_email.inbox_of),
so the owner can grant a plan before the person signs up, and '+tag' aliases (and
Gmail's ignored dots) of one inbox resolve to the same grant.

- 'pro': the per-student AI limits are PRO_AI_MULTIPLIER (3) times higher
  (rate_limit.PRO_AI_ACTIONS) and the account's share of the shared daily AI budget is
  PRO_ACCOUNT_SHARE_PERCENT instead of the Free share. No payments yet.
- 'unlimited': for people the owner trusts (teammates, testers). No per-student limits,
  like owners, but the global daily cap and the burst guard still apply. It gives no
  admin or owner powers.

A plan only counts for an account whose email is confirmed (email_confirmed_at), never
an unconfirmed or anonymous one. auth resolves it on each sign-in check and caches it in
rate_limit for PLAN_CACHE_SECONDS, so a revoke takes effect within a few minutes on
every server instance (immediately on the one that handled it).

The first time an account is seen with a plan (including owner accounts, shown as
Unlimited), it gets one plan_granted notification per plan level. Grants are keyed by
email and the backend can't look an email up, so the notice is sent at the account's
next sign-in check after the grant (within PLAN_CACHE_SECONDS while it is using bindet).
Revoking sends nothing.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from functools import lru_cache

from sqlalchemy import Column, DateTime, MetaData, String, Table, delete, select, update

import database
import rate_limit
from disposable_email import inbox_of, is_disposable

plans_metadata = MetaData()

account_plans = Table(
    "account_plans", plans_metadata,
    Column("email", String(320), primary_key=True),
    Column("plan", String(16), nullable=False, default="pro"),
    Column("granted_by", String(100), nullable=False, default=""),
    Column("granted_at", DateTime(timezone=True), nullable=False),
    Column("note", String(200), nullable=True),
)

PLAN_TABLES = ("account_plans",)
PLANS = ("pro", "unlimited")
NOTE_MAX = 200
EMAIL_MAX = 254
_EMAIL = re.compile(r"^[^@\s]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$")


@lru_cache(maxsize=1)
def init_plans() -> None:
    database.init_db()
    # Backend-only: RLS on and the anon/authenticated grants removed, in the same
    # transaction that creates the table (see database.create_locked_tables).
    database.create_locked_tables(database.engine(), plans_metadata, PLAN_TABLES, PLAN_TABLES)


def normalize_email(email: str | None) -> str:
    """The inbox to key a grant on, or '' when the address isn't a plausible email."""
    raw = (email or "").strip().lower()
    if not raw or len(raw) > EMAIL_MAX or not _EMAIL.match(raw):
        return ""
    return inbox_of(raw)


def confirmed_inbox(user: dict | None) -> str:
    """The inbox of a verified account with a confirmed email, else ''."""
    if not user or user.get("is_anonymous") or not user.get("email_confirmed_at"):
        return ""
    return inbox_of(user.get("email"))


def plan_for_email(inbox: str) -> str:
    if not inbox:
        return "free"
    init_plans()
    with database.engine().connect() as connection:
        plan = connection.execute(select(account_plans.c.plan).where(account_plans.c.email == inbox)).scalar_one_or_none()
    return plan if plan in PLANS else "free"


def plan_for_user(user: dict | None) -> str:
    return plan_for_email(confirmed_inbox(user))


def refresh(user: dict) -> None:
    """Called by auth for every verified account: re-read the plan once the cached one is stale.
    A database error counts as Free (until the next refresh) and never fails sign-in.
    The first time an account is seen with a plan, it gets a notification (notify_plan)."""
    student_id = str(user.get("id") or "")
    if not student_id or rate_limit.plan_is_fresh(student_id):
        return
    try:
        plan = plan_for_user(user)
    except Exception:  # noqa: BLE001 - a plan lookup must never block signing in
        plan = "free"
    rate_limit.mark_plan(student_id, plan)
    try:
        notify_plan(student_id, shown_plan(student_id))
    except Exception:  # noqa: BLE001 - a missed notice is retried at the next refresh
        pass


# Told once per account and plan level, in the app's notifications (Home and Friends).
PLAN_NOTICE_KIND = "plan_granted"
PLAN_NOTICES = {
    "pro": "You’ve been given bindet Pro: 3× more AI help every day.",
    "unlimited": "You’ve been given bindet Unlimited: no daily limits on AI features.",
}


def notify_plan(student_id: str, plan: str) -> bool:
    """Send the "you've been given a plan" notification unless this account already has it
    for this plan level. The notification itself is the record, so a revoke and re-grant,
    later sign-ins and other server instances never send it twice. Needs a profile (the
    notification references it); without one it waits for a later refresh. True if sent."""
    message = PLAN_NOTICES.get(plan)
    if not student_id or not message:
        return False
    database.init_db()
    notices = database.social_notifications
    with database.engine().begin() as connection:
        database._advisory_lock(connection, f"plan_notice:{student_id}")
        if connection.execute(select(database.profiles.c.student_id).where(
                database.profiles.c.student_id == student_id)).first() is None:
            return False
        if connection.execute(select(notices.c.id).where(
                notices.c.recipient_id == student_id, notices.c.kind == PLAN_NOTICE_KIND,
                notices.c.message == message).limit(1)).first() is not None:
            return False
        connection.execute(notices.insert().values(
            recipient_id=student_id, actor_id=None, kind=PLAN_NOTICE_KIND, message=message,
            is_read=False, created_at=datetime.now(timezone.utc),
        ))
    return True


def shown_plan(student_id: str) -> str:
    """The plan the student sees. Owner accounts have no per-student limits, so they are
    shown as Unlimited (student-facing text never calls them owners)."""
    return "unlimited" if rate_limit.is_owner(student_id) else rate_limit.plan_of(student_id)


def grant(email: str, plan: str, granted_by: str, note: str | None = None) -> dict:
    """Grant (or change) a plan for an email. Raises ValueError('invalid_email' |
    'disposable_email' | 'invalid_plan')."""
    inbox = normalize_email(email)
    if not inbox:
        raise ValueError("invalid_email")
    if is_disposable(inbox):
        raise ValueError("disposable_email")
    if plan not in PLANS:
        raise ValueError("invalid_plan")
    note = " ".join((note or "").split())[:NOTE_MAX] or None
    init_plans()
    now = datetime.now(timezone.utc)
    with database.engine().begin() as connection:
        values = {"plan": plan, "granted_by": granted_by, "granted_at": now, "note": note}
        if connection.execute(select(account_plans.c.email).where(account_plans.c.email == inbox)).first():
            connection.execute(update(account_plans).where(account_plans.c.email == inbox).values(**values))
        else:
            connection.execute(account_plans.insert().values(email=inbox, **values))
    rate_limit.forget_plans()
    return {"email": inbox, "plan": plan, "note": note or "", "granted_at": now}


def revoke(email: str) -> bool:
    inbox = inbox_of(email)
    if not inbox:
        return False
    init_plans()
    with database.engine().begin() as connection:
        removed = connection.execute(delete(account_plans).where(account_plans.c.email == inbox)).rowcount or 0
    rate_limit.forget_plans()
    return bool(removed)


def list_grants() -> list[dict]:
    init_plans()
    with database.engine().connect() as connection:
        rows = connection.execute(select(account_plans).order_by(account_plans.c.granted_at.desc())).mappings().all()
    return [{
        "email": row["email"], "plan": row["plan"], "note": row["note"] or "",
        "granted_at": row["granted_at"].replace(tzinfo=row["granted_at"].tzinfo or timezone.utc),
    } for row in rows]


def delete_for_account_in(connection, student_id: str, email: str | None) -> None:
    """Account deletion, inside its transaction: the grant for the account's own confirmed
    inbox goes, and grants it made for other people stay (they keep their plan) but no
    longer name it."""
    inbox = inbox_of(email)
    if inbox:
        connection.execute(delete(account_plans).where(account_plans.c.email == inbox))
    connection.execute(update(account_plans).where(account_plans.c.granted_by == student_id).values(granted_by=""))
    rate_limit.forget_plans()


def reset_plans() -> None:
    init_plans()
    with database.engine().begin() as connection:
        connection.execute(delete(account_plans))
    rate_limit.forget_plans()
