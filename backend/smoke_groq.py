"""Live check of every AI feature against Groq, run by hand (not part of the test suite).

    python smoke_groq.py [path/to/sample-notes-folder]

Needs GROQ_API_KEY in the environment or in backend/.env; the key is never printed. Makes
about 13 real requests (well inside Groq's free plan) and prints one line per feature:
PASS or FAIL, how long it took and a short summary of the output.
"""
from __future__ import annotations

import io
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
os.environ.setdefault("POCKET_TUTOR_DB_PATH", str(HERE / "smoke-groq.db"))


def load_env() -> None:
    env = HERE / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        name, sep, value = line.partition("=")
        if sep and name.strip() and not name.strip().startswith("#"):
            os.environ.setdefault(name.strip(), value.strip().strip('"').strip("'"))


load_env()
if not os.getenv("GROQ_API_KEY"):
    sys.exit("GROQ_API_KEY is not set (environment or backend/.env).")

import ai_tutor  # noqa: E402  (after the environment is ready)
import help_bot  # noqa: E402
import study_guides  # noqa: E402

PAUSE_SECONDS = float(os.getenv("SMOKE_PAUSE_SECONDS", "6"))
results: list[tuple[str, bool]] = []


def check(name: str, run) -> object | None:
    started = time.perf_counter()
    try:
        summary, value = run()
    except Exception as error:  # noqa: BLE001 - report every failure and keep going
        print(f"FAIL  {name:<24} {time.perf_counter() - started:5.1f}s  {type(error).__name__}: {str(error)[:120]}")
        results.append((name, False))
        value = None
    else:
        print(f"PASS  {name:<24} {time.perf_counter() - started:5.1f}s  {summary}")
        results.append((name, True))
    time.sleep(PAUSE_SECONDS)
    return value


def text_image(lines: list[str]) -> bytes:
    from PIL import Image, ImageDraw, ImageFont
    image = Image.new("RGB", (1400, 220 + 90 * len(lines)), "white")
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.load_default(size=56)
    except TypeError:
        font = ImageFont.load_default()
    for index, line in enumerate(lines):
        draw.text((60, 80 + 90 * index), line, fill="black", font=font)
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=90)
    return output.getvalue()


def main() -> None:
    folder = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent.parent / "Bindet-tasks" / "cac-demo-notes"
    biology = (folder / "biology-photosynthesis.txt").read_text() if (folder / "biology-photosynthesis.txt").exists() else (
        "Photosynthesis turns light energy into chemical energy. The light reactions happen in the thylakoid membranes and "
        "make ATP and NADPH. The Calvin cycle in the stroma uses them to fix carbon dioxide into glucose. Rubisco is the enzyme "
        "that fixes CO2. High temperatures slow photosynthesis because enzymes like rubisco denature and stomata close.")
    trig = (folder / "precalc-trig.md").read_text() if (folder / "precalc-trig.md").exists() else "Radians: $\\pi$ rad = 180 degrees."
    print(f"Groq models: text={ai_tutor.AI_MODEL} long={ai_tutor.AI_LONG_MODEL} chat={ai_tutor.AI_CHAT_MODEL} "
          f"strong={ai_tutor.AI_STRONG_MODEL} vision={ai_tutor.AI_VISION_MODEL} small={ai_tutor.AI_SMALL_MODEL}\n")

    deck = check("flashcards", lambda: (lambda batch: (f"{len(batch.cards)} cards, e.g. {batch.cards[0]['front'][:60]!r}", batch))(
        ai_tutor.generate_note_flashcards(course="AP Biology", unit="Photosynthesis", file_name="biology.txt", note_text=biology)))
    check("practice test (hard)", lambda: (lambda batch: (f"{len(batch.questions)} questions", batch))(
        ai_tutor.generate_practice_test(course="AP Biology", unit="Photosynthesis", note_text=biology, count=5, difficulty="hard")))
    check("conversation title", lambda: (lambda title: (repr(title), title))(
        ai_tutor.generate_title(first_message="why does photosynthesis slow down when it's really hot?",
                                reply="High heat denatures enzymes like rubisco and makes stomata close.")))
    check("photo OCR", lambda: (lambda text: (repr(text[:70]), text))(
        ai_tutor.extract_image_notes(image_bytes=text_image(["Mitosis has four phases:", "prophase, metaphase,", "anaphase, telophase."]),
                                     content_type="image/jpeg")))
    check("Otto (everyday)", lambda: (lambda text: (f"{len(text)} chars streamed", text))("".join(ai_tutor.stream_tutor_reply(
        messages=[{"role": "system", "content": ai_tutor.tutor_system_prompt()},
                  {"role": "user", "content": ai_tutor.tutor_user_text("explain fotosynthesis simply", "AP Biology", "Photosynthesis",
                                                                       ["biology.txt"], biology)}],
        route=ai_tutor.tutor_route("explain fotosynthesis simply", False)))))
    check("help bot", lambda: (lambda text: (repr(text[:70]), text))(help_bot.ask_model("how do I add a friend?")))
    check("quiz question (LaTeX)", lambda: (lambda question: (repr(question["question"][:70]), question))(
        ai_tutor.generate_question(course="Precalculus", unit="Radians", source_labels=["trig.md"], focus="mixed", difficulty=2,
                                   personalization={}, source_text=trig)))
    check("grade answer (pi/2)", lambda: (lambda grade: (f"correct={grade['correct']} score={grade['score']}", grade))(
        ai_tutor.grade_answer(question="What is 90 degrees in radians?", correct_answer="$\\frac{\\pi}{2}$",
                              student_answer="pi/2", topic="Radians", difficulty=1)))
    check("study guide", lambda: (lambda batch: (f"{len(batch.sections)} sections", batch))(
        study_guides.generate(kind="study_guide", course="AP Biology", unit="Photosynthesis", note_text=biology)))
    check("Otto (hard question)", lambda: (lambda text: (f"{len(text)} chars streamed", text))("".join(ai_tutor.stream_tutor_reply(
        messages=[{"role": "system", "content": ai_tutor.tutor_system_prompt()}, {"role": "user", "content": "Explain why " * 80 + "the Calvin cycle needs ATP, step by step."}],
        route=ai_tutor.tutor_route("Explain why " * 80 + "the Calvin cycle needs ATP, step by step.", False)))))
    check("grade practice answers", lambda: (lambda grades: (f"{len(grades)} graded", grades))(
        ai_tutor.grade_practice_answers([{"id": 1, "question": "Where do the light reactions happen?", "reference": "Thylakoid membranes", "answer": "in the thylakoids"},
                                         {"id": 2, "question": "Which enzyme fixes CO2?", "reference": "Rubisco", "answer": "ATP synthase"}])))
    check("Otto memory", lambda: (lambda ops: (f"{len(ops)} memory ops", ops))(
        ai_tutor.memory_update_ops(items=[], turns=[{"role": "user", "content": "I have an AP Bio test on Friday and I learn best with diagrams."}],
                                   today="2026-10-16")))
    from PIL import Image
    pages = [Image.open(io.BytesIO(text_image([f"Page {number}: The Calvin cycle", "uses ATP and NADPH."]))) for number in (1, 2)]
    scan = io.BytesIO()
    pages[0].save(scan, format="PDF", save_all=True, append_images=pages[1:])
    import note_ingestion
    check("scanned PDF OCR", lambda: (lambda text: (repr(text[:70]), text))(
        ai_tutor.extract_pdf_notes(page_images=note_ingestion.pdf_page_images(scan.getvalue())[0])))

    passed = sum(ok for _, ok in results)
    print(f"\n{passed}/{len(results)} features passed.")
    if deck is not None:
        print("Example card:", deck.cards[0])
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
