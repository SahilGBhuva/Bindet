"""Permanently delete a bindit account and everything that belongs to it.

delete_account_data() removes every row tied to the student in one database
transaction (under a per-account advisory lock on Postgres), in an order that is
safe for foreign keys:

- Study groups: a group the student owns alone is deleted (its tasks are released
  the same way as deleting a group by hand); a group with other members passes to
  the member who joined earliest, who is notified. Then every membership goes.
- Tasks: personal tasks are deleted. Group tasks the student created stay with the
  group and pass to the group's owner, so the group keeps its work. The student's
  comments, attachments, assignments and activity on any task are removed.
- Notes, flashcards (cards, jobs, styles, review state), tutor conversations and messages,
  generated questions, private question banks and every AI cache entry tied to the
  account (ai_cache.purge_user_ai_data_in; shared entries another user's identical
  upload still references are kept).
- Progress (student_progress, topic_progress, xp_events, progress_claims), friends,
  friend quests, blocks and reports (both directions), reactions, notifications to
  and from the student, rate-limit events, uploaded_images rows and the profile.
- On Postgres, the browser-written group chat rows: messages the student sent, their
  read receipts and typing state.

It is idempotent: running it again for an account with no data deletes nothing.
Storage objects (chat images and private images) and the Supabase Auth user are
deleted by the route around it (main.delete_account), outside the transaction.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import delete, or_, select, text, update

import ai_cache
import database
import flashcards
import note_store
import questions
import tasks
import tutor

logger = logging.getLogger("bindit.account")

# Tables the browser writes directly (created by supabase/migrations, Postgres only).
CHAT_TABLES = ("study_group_messages", "study_group_chat_reads", "study_group_chat_typing")


def init_all() -> None:
    database.init_db()
    note_store.init_notes()
    flashcards.init_flashcards()
    questions.init_questions()
    tutor.init_tutor()
    tasks.init_tasks()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _chat_tables_present(connection) -> set[str]:
    if connection.dialect.name != "postgresql":
        return set()
    return {
        name for name in CHAT_TABLES
        if connection.execute(text("SELECT to_regclass(:name)"), {"name": f"public.{name}"}).scalar() is not None
    }


def group_ids(student_id: str) -> list[str]:
    """Every group the student belongs to (used to find their chat images)."""
    init_all()
    members = database.study_group_members
    with database.engine().connect() as connection:
        return sorted(connection.execute(select(members.c.group_id).where(members.c.student_id == student_id)).scalars().all())


def _settle_groups(connection, student_id: str) -> dict:
    """Delete the groups the student owns alone, hand the others to the longest-standing
    member, then drop every membership. Returns {"deleted": [...], "transferred": {group: new_owner}}."""
    members = database.study_group_members
    groups = database.study_groups
    memberships = connection.execute(select(members.c.group_id, members.c.role).where(
        members.c.student_id == student_id,
    ).order_by(members.c.group_id)).all()
    deleted: list[str] = []
    transferred: dict[str, str] = {}
    for group_id, _role in memberships:
        database._advisory_lock(connection, f"groups:group:{group_id}")
    database._advisory_lock(connection, f"groups:student:{student_id}")
    owned = {row[0] for row in connection.execute(select(groups.c.id).where(groups.c.owner_id == student_id)).all()}
    owned |= {group_id for group_id, role in memberships if role == "owner"}
    for group_id in sorted(owned):
        successor = connection.execute(select(members.c.student_id).where(
            members.c.group_id == group_id, members.c.student_id != student_id,
        ).order_by(members.c.joined_at.asc(), members.c.id.asc()).limit(1)).scalar_one_or_none()
        if successor is None:
            # Nobody else is in it: delete it like the owner deleting it by hand. Group tasks
            # become their creators' personal tasks (the creators are this student, or
            # former members whose work is kept), milestones and analytics activity go.
            database._delete_group(connection, student_id, group_id,
                                   on_delete=lambda conn, gid=group_id: tasks.release_group_work(conn, gid))
            deleted.append(group_id)
            continue
        connection.execute(update(members).where(members.c.group_id == group_id, members.c.student_id == successor).values(role="owner"))
        connection.execute(update(groups).where(groups.c.id == group_id).values(owner_id=successor))
        name = connection.execute(select(groups.c.name).where(groups.c.id == group_id)).scalar_one_or_none() or "your group"
        # actor_id stays empty: the notification must outlive the deleted account.
        connection.execute(database.social_notifications.insert().values(
            recipient_id=successor, actor_id=None, kind="group_owner",
            message=f"A member deleted their account, so you’re now the owner of {name}."[:240],
            is_read=False, created_at=_now(),
        ))
        transferred[group_id] = successor
    connection.execute(delete(members).where(members.c.student_id == student_id))
    return {"deleted": deleted, "transferred": transferred}


def _settle_tasks(connection, student_id: str) -> int:
    """Delete personal tasks, hand group tasks the student created to the group owner,
    and remove the student's comments, attachments, assignments and activity. Returns how
    many group tasks were handed over."""
    t = tasks.tasks
    owned = connection.execute(select(t.c.id, t.c.group_id, t.c.title).where(t.c.owner_id == student_id)).mappings().all()
    personal = [row["id"] for row in owned if row["group_id"] is None]
    for table in tasks.CHILD_TABLES:
        if personal:
            connection.execute(delete(table).where(table.c.task_id.in_(personal)))
    if personal:
        connection.execute(delete(t).where(t.c.id.in_(personal)))

    handed = 0
    for row in owned:
        if row["group_id"] is None:
            continue
        new_owner = connection.execute(select(database.study_groups.c.owner_id).where(
            database.study_groups.c.id == row["group_id"],
        )).scalar_one_or_none()
        if new_owner is None or new_owner == student_id:
            # The group is gone (release_group_work already made this a personal task, so
            # this cannot normally happen); delete the task rather than orphan it.
            for table in tasks.CHILD_TABLES:
                connection.execute(delete(table).where(table.c.task_id == row["id"]))
            connection.execute(delete(t).where(t.c.id == row["id"]))
            continue
        connection.execute(update(t).where(t.c.id == row["id"]).values(owner_id=new_owner, updated_at=_now()))
        connection.execute(tasks.task_activity.insert().values(
            task_id=row["id"], group_id=row["group_id"], actor_id=new_owner, kind="owner",
            detail="Handed to the group owner (its creator deleted their account)", created_at=_now(),
        ))
        handed += 1

    connection.execute(delete(tasks.task_comments).where(tasks.task_comments.c.author_id == student_id))
    connection.execute(delete(tasks.task_attachments).where(tasks.task_attachments.c.added_by == student_id))
    connection.execute(delete(tasks.task_assignees).where(tasks.task_assignees.c.student_id == student_id))
    connection.execute(delete(tasks.task_activity).where(tasks.task_activity.c.actor_id == student_id))
    # Milestones belong to their group; one the student created stays, credited to the owner.
    milestones = tasks.group_milestones
    for milestone_id, group_id in connection.execute(select(milestones.c.id, milestones.c.group_id).where(
        milestones.c.created_by == student_id,
    )).all():
        owner = connection.execute(select(database.study_groups.c.owner_id).where(
            database.study_groups.c.id == group_id,
        )).scalar_one_or_none()
        if owner is None or owner == student_id:
            connection.execute(update(t).where(t.c.milestone_id == milestone_id).values(milestone_id=None))
            connection.execute(delete(milestones).where(milestones.c.id == milestone_id))
        else:
            connection.execute(update(milestones).where(milestones.c.id == milestone_id).values(created_by=owner))
    # The older single-table task list.
    connection.execute(delete(database.study_tasks).where(database.study_tasks.c.owner_id == student_id))
    return handed


def _delete_study_material(connection, student_id: str) -> int:
    notes = note_store.notes
    connection.execute(delete(flashcards.reviews).where(flashcards.reviews.c.owner_id == student_id))
    connection.execute(delete(flashcards.cards).where(flashcards.cards.c.owner_id == student_id))
    connection.execute(delete(flashcards.jobs).where(flashcards.jobs.c.owner_id == student_id))
    connection.execute(delete(flashcards.styles).where(flashcards.styles.c.owner_id == student_id))
    connection.execute(delete(notes).where(notes.c.student_id == student_id))
    conversation_ids = select(tutor.conversations.c.id).where(tutor.conversations.c.owner_id == student_id)
    connection.execute(delete(tutor.messages).where(tutor.messages.c.conversation_id.in_(conversation_ids)))
    connection.execute(delete(tutor.conversations).where(tutor.conversations.c.owner_id == student_id))
    # Cache references, entries nobody else references, tutor replies, private question
    # banks and served questions (generated_questions).
    return ai_cache.purge_user_ai_data_in(connection, student_id)


def _delete_social(connection, student_id: str) -> None:
    db = database
    own_events = select(db.xp_events.c.id).where(db.xp_events.c.student_id == student_id)
    connection.execute(delete(db.social_reactions).where(or_(
        db.social_reactions.c.reactor_id == student_id, db.social_reactions.c.event_id.in_(own_events),
    )))
    connection.execute(delete(db.social_notifications).where(or_(
        db.social_notifications.c.recipient_id == student_id, db.social_notifications.c.actor_id == student_id,
    )))
    connection.execute(delete(db.friend_quests).where(or_(
        db.friend_quests.c.creator_id == student_id, db.friend_quests.c.partner_id == student_id,
    )))
    connection.execute(delete(db.friendships).where(or_(
        db.friendships.c.requester_id == student_id, db.friendships.c.recipient_id == student_id,
    )))
    connection.execute(delete(db.social_blocks).where(or_(
        db.social_blocks.c.blocker_id == student_id, db.social_blocks.c.blocked_id == student_id,
    )))
    # Reports about the student reference their profile too (ON DELETE CASCADE on Postgres).
    connection.execute(delete(db.social_reports).where(or_(
        db.social_reports.c.reporter_id == student_id, db.social_reports.c.reported_id == student_id,
    )))
    connection.execute(delete(db.social_action_events).where(db.social_action_events.c.student_id == student_id))


def delete_account_data(student_id: str) -> dict:
    """Delete every row tied to student_id in one transaction. Returns a summary
    ({"groups_deleted", "groups_transferred", "tasks_handed_over", "cache_rows",
    "image_paths"}); image_paths are the private-bucket objects named by uploaded_images,
    which the caller deletes from storage."""
    if not student_id:
        raise ValueError("student_required")
    init_all()
    db = database
    with flashcards._guard(), db.engine().begin() as connection:
        db._advisory_lock(connection, f"account:{student_id}")
        chat_tables = _chat_tables_present(connection)
        groups = _settle_groups(connection, student_id)
        handed = _settle_tasks(connection, student_id)
        cache_rows = _delete_study_material(connection, student_id)
        _delete_social(connection, student_id)

        if "study_group_messages" in chat_tables:
            connection.execute(text("DELETE FROM public.study_group_messages WHERE sender_id = :id"), {"id": student_id})
        for name in ("study_group_chat_reads", "study_group_chat_typing"):
            if name in chat_tables:
                connection.execute(text(f"DELETE FROM public.{name} WHERE student_id = :id"), {"id": student_id})

        image_paths = connection.execute(select(db.uploaded_images.c.storage_path).where(
            db.uploaded_images.c.owner_id == student_id,
        )).scalars().all()
        connection.execute(delete(db.uploaded_images).where(db.uploaded_images.c.owner_id == student_id))
        connection.execute(delete(db.progress_claims).where(db.progress_claims.c.account_id == student_id))
        connection.execute(delete(db.xp_events).where(db.xp_events.c.student_id == student_id))
        connection.execute(delete(db.profiles).where(db.profiles.c.student_id == student_id))
        connection.execute(delete(db.topic_progress).where(db.topic_progress.c.student_id == student_id))
        connection.execute(delete(db.student_progress).where(db.student_progress.c.student_id == student_id))
    return {
        "groups_deleted": groups["deleted"],
        "groups_transferred": groups["transferred"],
        "tasks_handed_over": handed,
        "cache_rows": cache_rows,
        "image_paths": sorted(image_paths),
    }
