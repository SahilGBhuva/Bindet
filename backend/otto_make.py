"""Otto makes a flashcard deck or a practice quiz from the conversation, right in the chat.

"Make flashcards on this", "turn this into flashcards", "quiz me", "give me a practice test on
what we talked about": a pattern (never a model call) spots the request, and the source is the
conversation itself, the recent turns about the topic and Otto's explanations, plus the matching
paragraphs of the selected unit's notes. That source is saved once as a text note in the
conversation's course and unit ("From Otto: <conversation title>"), so it lives in the student's
binder, and the normal note pipelines make the cards (main.note_flashcards) and the quiz
(main.make_practice_test) from it: the same limits, AI budget, grounding checks and caches.

This module holds only the pure parts: intent detection, building the source text, and naming
the note. Nothing here touches the database or the AI.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import ai_tutor
from study_guides import _near

INTENT_MAX_CHARS = 160
QUIZ_COUNTS = (5, 8, 12)
DEFAULT_QUIZ_COUNT = 8
SOURCE_CHAT_CHARS = 9_000        # conversation text kept in the note, newest turns first
SOURCE_NOTES_CHARS = 3_000       # matching paragraphs of the unit's notes
NOTE_PREFIX = "From Otto: "
NOTE_NAME_MAX = 110
# Otto's own fixed replies are not study material.
SKIPPED_TIERS = {"small_talk", "study_guide", "otto_make"}

# Words matched with one typo allowed (study_guides._near), so "flashcrads" or "quizz" still count.
_FUZZY = {
    "flashcards": ("flashcards", "flashcard", "flascards", "flashcads"),
    "practice": ("practice", "practise"),
    "quiz": ("quiz", "quizz", "quizes", "quizzes"),
    "questions": ("questions", "question"),
    "please": ("please",),
    "generate": ("generate",),
    "create": ("create",),
    "conversation": ("conversation",),
}
_NUMBERS = {"three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
            "eleven": 11, "twelve": 12, "fifteen": 15}

_ASK = r"(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+|otto,?\s+|i\s+(?:need|want|would\s+like)\s+|i'?d\s+like\s+|let'?s\s+)?(?:please\s+)?"
_VERB = r"(?:make|create|build|generate|write|give|prepare|put\s+together|draft|do|set\s+up)(?:\s+(?:me|us))?"
_TARGET = r"(?:\s+(?:on|for|about|from|of|covering|over)\s+(?P<target>[^?!.\n]{1,80}?))?"
_COUNT = r"(?:\s+(?:with|of)\s+(?P<count>\d{1,2})\s+questions)?"
_END = r"\s*[?!.]*\s*(?:please|thanks|thank\s+you|pls)?[?!.]*\s*$"
_THIS = r"(?:this|that|it|these|those|all\s+(?:of\s+)?(?:this|that)|everything|our\s+(?:chat|conversation)|this\s+(?:chat|conversation|topic))"

_CARDS = r"(?:(?:a|some|a\s+few|a\s+set\s+of|a\s+deck\s+of|the)\s+)?(?:flashcards(?:\s+deck)?|deck\s+of\s+flashcards|cards)"
_TEST = r"(?:(?:a|an|some|another|me\s+a)\s+)?(?:(?:quick|short|new|little|mini|mock)\s+)?(?:practice\s+(?:test|quiz|exam)|quiz|test|mock\s+(?:test|exam))"

_FLASHCARD_PATTERNS = [
    re.compile(rf"^{_ASK}{_VERB}\s+(?:me\s+)?{_CARDS}{_TARGET}{_END}"),
    re.compile(rf"^{_ASK}(?:turn|convert|make|change)\s+{_THIS}\s+into\s+(?:a\s+(?:deck\s+of\s+|set\s+of\s+)?|some\s+)?(?:flashcards(?:\s+deck)?|deck)(?:\s+for\s+me)?{_END}"),
    re.compile(rf"^(?:flashcards(?:\s+deck)?)(?:\s+(?:on|for|about|from|of|covering)\s+(?P<target>[^?!.\n]{{1,80}}?))?{_END}"),
]
_QUIZ_PATTERNS = [
    re.compile(rf"^{_ASK}(?:quiz|test)\s+me{_TARGET}{_COUNT}{_END}"),
    re.compile(rf"^{_ASK}(?:quiz|test)\s+me{_COUNT}{_TARGET}{_END}"),
    re.compile(rf"^{_ASK}{_VERB}\s+{_TEST}{_TARGET}{_COUNT}{_END}"),
    re.compile(rf"^{_ASK}{_VERB}\s+{_TEST}{_COUNT}{_TARGET}{_END}"),
    re.compile(rf"^{_ASK}(?:turn|convert|make)\s+{_THIS}\s+into\s+{_TEST}{_END}"),
    re.compile(rf"^(?:practice\s+test|quiz)(?:\s+(?:on|for|about|from|covering)\s+(?P<target>[^?!.\n]{{1,80}}?))?{_END}"),
]
# "on this", "on what we talked about": the conversation itself, not a named topic.
_WHOLE_CHAT = re.compile(
    rf"^(?:{_THIS}|what\s+we(?:'ve|\s+have)?\s+(?:talked|been\s+talking|discussed|covered|went\s+over|just\s+(?:talked|discussed|covered))(?:\s+about)?(?:\s+(?:so\s+far|today|here))?"
    r"|the\s+(?:chat|conversation|topic|above)|(?:this|that)\s+(?:stuff|topic|material|lesson|explanation|answer|reply))$"
)
_FILLER = re.compile(r"^(?:the|my|our)\s+|\s+(?:please|pls|for\s+me|stuff)$")


@dataclass
class MakeIntent:
    kind: str           # "flashcards" | "quiz"
    target: str         # a topic the student named ("mitosis"), or "" for the conversation itself
    count: int | None   # questions asked for ("quiz me with 5 questions"), quizzes only


def _canonical(text: str) -> str:
    """Lowercased, apostrophes straightened, "flash cards" joined, number words as digits, and
    one-typo variants of the key words replaced by the word itself."""
    value = " ".join(ai_tutor._plain(text or "").replace("’", "'").casefold().split())
    value = re.sub(r"\bflash[\s-]+cards?\b", "flashcards", value)
    words = []
    for word in re.split(r"(\s+)", value):
        bare = word.strip("?!.,")
        replacement = None
        if bare in _NUMBERS:
            replacement = str(_NUMBERS[bare])
        elif len(bare) >= 4:
            for canon, forms in _FUZZY.items():
                if any(_near(bare, form) for form in forms):
                    replacement = canon
                    break
        words.append(word.replace(bare, replacement, 1) if replacement and bare else word)
    return "".join(words)


def _clean_target(target: str) -> str:
    target = (target or "").strip(" ,;:")
    for _ in range(3):
        target = _FILLER.sub("", target).strip()
    return "" if not target or _WHOLE_CHAT.match(target) else target


def detect_intent(text: str) -> MakeIntent | None:
    """An explicit request for flashcards or a practice quiz, else None. Narrow on purpose:
    a question about flashcards ("what are flashcards?", "how do I make flashcards"), a long
    message, or a request with more instructions after it gets a normal answer."""
    raw = " ".join((text or "").split())
    if not raw or len(raw) > INTENT_MAX_CHARS:
        return None
    value = _canonical(raw)
    for kind, patterns in (("flashcards", _FLASHCARD_PATTERNS), ("quiz", _QUIZ_PATTERNS)):
        for pattern in patterns:
            match = pattern.match(value)
            if match is None:
                continue
            groups = match.groupdict()
            target = _clean_target(groups.get("target") or "")
            count = int(groups["count"]) if kind == "quiz" and groups.get("count") else None
            if target:
                # Keep the student's own case for the topic when it can be found as typed.
                found = re.search(re.escape(target), raw, re.I)
                target = found.group(0) if found else target
            return MakeIntent(kind=kind, target=target[:80], count=count)
    return None


def quiz_count(count: int | None) -> int:
    """The quiz length: the student's number clamped to 5..15, else 8."""
    if count is None:
        return DEFAULT_QUIZ_COUNT
    return max(ai_tutor.PRACTICE_MIN_QUESTIONS, min(ai_tutor.PRACTICE_MAX_QUESTIONS, int(count)))


# --- Source -------------------------------------------------------------------------------------

_MARKDOWN = re.compile(r"(?m)^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?=\S))|\*\*|__|`{1,3}")


def _plain_turn(text: str) -> str:
    """A turn as plain text: markdown marks dropped (LaTeX kept), blank lines squeezed."""
    value = _MARKDOWN.sub("", ai_tutor._CONTROL_CHARS.sub("", ai_tutor._plain(text or "")))
    value = re.sub(r"\n{3,}", "\n\n", value)
    return "\n".join(line.rstrip() for line in value.strip().splitlines())


def _is_fixed(turn: dict) -> bool:
    content = (turn.get("content") or "").strip()
    return turn.get("model_tier") in SKIPPED_TIERS or content == ai_tutor.TUTOR_REFUSAL or not content


def chat_source(turns: list[dict], target: str = "") -> str:
    """The conversation as study material: each of the student's questions with Otto's answer,
    oldest first, newest kept when it is too long. Otto's fixed replies (small talk, refusals,
    earlier decks and quizzes) and the student's requests for them are left out. With a target
    ("flashcards for mitosis"), only the exchanges that mention it, when any do."""
    pairs: list[tuple[str, str]] = []
    question = ""
    for turn in turns:
        if turn.get("role") == "user":
            question = "" if detect_intent(turn.get("content") or "") else _plain_turn(turn.get("content") or "")
            continue
        if _is_fixed(turn):
            question = ""
            continue
        pairs.append((question, _plain_turn(turn["content"])))
        question = ""
    if target:
        wanted = ai_tutor._content_tokens(target)
        focused = [pair for pair in pairs if wanted and wanted & ai_tutor._content_tokens(pair[0] + " " + pair[1])]
        pairs = focused or pairs
    blocks: list[str] = []
    used = 0
    for asked, answer in reversed(pairs):
        block = (f"Question: {asked}\n\n" if asked else "") + answer
        if used + len(block) > SOURCE_CHAT_CHARS:
            if not blocks:
                blocks.append(block[-SOURCE_CHAT_CHARS:])
            break
        blocks.append(block)
        used += len(block) + 2
    return "\n\n".join(reversed(blocks)).strip()


def notes_excerpt(note_text: str, about: str, limit: int = SOURCE_NOTES_CHARS) -> str:
    """The paragraphs of the unit's notes that share at least two content words with `about`
    (the chat source or the named topic; one word is enough for a short topic), in note order."""
    wanted = ai_tutor._content_tokens(about)
    if not wanted or not (note_text or "").strip():
        return ""
    need = 1 if len(wanted) <= 2 else 2
    kept: list[str] = []
    used = 0
    for paragraph in re.split(r"\n\s*\n|(?<=[.!?])\s{2,}", note_text):
        paragraph = " ".join(paragraph.split())
        if len(paragraph) < 40 or len(wanted & ai_tutor._content_tokens(paragraph)) < need:
            continue
        if used + len(paragraph) > limit:
            break
        kept.append(paragraph)
        used += len(paragraph) + 2
    return "\n\n".join(kept)


def note_text(title: str, chat: str, notes: str) -> str:
    """The saved note: a heading, then what was said in the chat, then the matching notes."""
    parts = [title]
    if chat:
        parts.append("From our chat with Otto:\n\n" + chat)
    if notes:
        parts.append("From your notes:\n\n" + notes)
    return "\n\n".join(parts).strip()


_QUESTION_LEAD = re.compile(r"^(?:what\s+(?:is|are|was|were)|what's|whats|who\s+(?:is|was)|explain|define|how\s+(?:does|do|did)|tell\s+me\s+about)\s+(?:an?\s+|the\s+)?", re.I)


def topic_title(conversation_title: str, target: str, unit: str) -> str:
    """What the deck or quiz is about, for the note name and Otto's reply."""
    title = " ".join((conversation_title or "").split())
    if target:
        return target[:80]
    if title and title != ai_tutor.DEFAULT_TITLE and not detect_intent(title):
        # A question-style title ("What is apoptosis?") names its topic ("apoptosis").
        topic = re.sub(r"\s+(?:work|works|happen|happens|mean|means)$", "", _QUESTION_LEAD.sub("", title).strip(" ?!."), flags=re.I)
        topic = topic[:1].upper() + topic[1:] if topic else title
        return topic[:80]
    return unit[:80] or "our chat"


def note_name(topic: str, taken: list[str]) -> str:
    """ "From Otto: <topic>", or "From Otto: <topic> (2)" when that name already holds other text."""
    base = (NOTE_PREFIX + " ".join(topic.split()))[:NOTE_NAME_MAX].rstrip()
    if base not in taken:
        return base
    number = 2
    while f"{base} ({number})" in taken:
        number += 1
    return f"{base} ({number})"


def same_note(name: str, topic: str) -> bool:
    """True for "From Otto: <topic>" and its numbered copies."""
    base = (NOTE_PREFIX + " ".join(topic.split()))[:NOTE_NAME_MAX].rstrip()
    return name == base or bool(re.fullmatch(re.escape(base) + r" \(\d+\)", name))


# --- Message attachments ------------------------------------------------------------------------
#
# Otto's reply carries what it made, so the card is there when the chat is opened again:
#   "deck:<note id>"                 a flashcard deck (the note's cards)
#   "quiz:<test id>:<note id>"       a practice quiz (the test) and the note it was written from
#   "pick:flashcards" / "pick:quiz:<count>"   Otto asks which course and unit to save to

def deck_attachment(note_id: str) -> str:
    return f"deck:{note_id}"


def quiz_attachment(test_id: str, note_id: str) -> str:
    return f"quiz:{test_id}:{note_id}"


def pick_attachment(kind: str, count: int | None = None) -> str:
    return "pick:flashcards" if kind == "flashcards" else f"pick:quiz:{quiz_count(count)}"
