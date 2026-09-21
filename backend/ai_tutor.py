from __future__ import annotations

import base64
import json
import os
from functools import lru_cache
from typing import Any

import httpx

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
_configured_text_model = os.getenv("OPENROUTER_MODEL", "").strip()
OPENROUTER_MODEL = "google/gemini-3.5-flash-lite" if _configured_text_model in {"", "openrouter/auto"} else _configured_text_model
OPENROUTER_VISION_MODEL = os.getenv("OPENROUTER_VISION_MODEL", "google/gemini-3.1-flash-lite")
OPENROUTER_TIMEOUT = float(os.getenv("OPENROUTER_TIMEOUT_SECONDS", "12"))
OPENROUTER_VISION_TIMEOUT = float(os.getenv("OPENROUTER_VISION_TIMEOUT_SECONDS", "8"))

class AITutorError(RuntimeError):
    pass

@lru_cache(maxsize=1)
def _client() -> httpx.Client:
    return httpx.Client(timeout=httpx.Timeout(OPENROUTER_TIMEOUT, connect=4.0), limits=httpx.Limits(max_keepalive_connections=20, max_connections=50, keepalive_expiry=30.0), http2=True)

def _headers() -> dict[str, str]:
    key = os.getenv("OPENROUTER_API_KEY")
    if not key:
        raise AITutorError("OPENROUTER_API_KEY is not configured")
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json", "X-OpenRouter-Title": "bindet"}

def _extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:].strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise AITutorError("AI returned invalid JSON") from exc
    if not isinstance(data, dict):
        raise AITutorError("AI returned an invalid response shape")
    return data

def _post(payload: dict[str, Any], *, timeout: float | None = None) -> dict[str, Any]:
    try:
        response = _client().post(OPENROUTER_URL, headers=_headers(), json=payload, timeout=timeout or OPENROUTER_TIMEOUT)
        response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, json.JSONDecodeError) as exc:
        raise AITutorError("OpenRouter request failed") from exc

def _chat_json(*, system_prompt: str, data: dict[str, Any], temperature: float, max_tokens: int, schema_name: str, schema: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "model": OPENROUTER_MODEL,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "reasoning": {"effort": "minimal"},
        "provider": {"sort": "latency", "preferred_max_latency": 1.5, "allow_fallbacks": True, "require_parameters": True},
        "response_format": {"type": "json_schema", "json_schema": {"name": schema_name, "strict": True, "schema": schema}},
        "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": json.dumps(data, ensure_ascii=False, separators=(",", ":"))}],
    }
    try:
        content = _post(payload)["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise AITutorError("OpenRouter returned an unexpected response") from exc
    return _extract_json(content)

def extract_image_notes(*, image_bytes: bytes, content_type: str) -> str:
    encoded = base64.b64encode(image_bytes).decode("ascii")
    payload = {"model": OPENROUTER_VISION_MODEL, "temperature": 0, "max_tokens": 1200, "reasoning": {"effort": "minimal"}, "provider": {"sort": "throughput", "preferred_max_latency": 2, "preferred_min_throughput": 80, "allow_fallbacks": True}, "messages": [{"role": "user", "content": [{"type": "text", "text": "Fast, accurate OCR for study notes. Return only the readable educational text, headings, labels, equations, and diagram facts. Never guess unreadable text."}, {"type": "image_url", "image_url": {"url": f"data:{content_type};base64,{encoded}"}}]}]}
    try:
        text = _post(payload, timeout=OPENROUTER_VISION_TIMEOUT)["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise AITutorError("Vision model returned an unexpected response") from exc
    if not text:
        raise AITutorError("No readable notes were found in that image")
    return text[:120000]

def extract_pdf_notes(*, pdf_bytes: bytes) -> str:
    encoded = base64.b64encode(pdf_bytes).decode("ascii")
    payload = {"model": OPENROUTER_VISION_MODEL, "temperature": 0, "max_tokens": 2000, "reasoning": {"effort": "minimal"}, "provider": {"sort": "throughput", "preferred_max_latency": 2, "allow_fallbacks": True}, "plugins": [{"id": "file-parser", "pdf": {"engine": "mistral-ocr"}}], "messages": [{"role": "user", "content": [{"type": "text", "text": "OCR this scanned study-note PDF. Return only readable educational text, headings, labels, equations, and diagram facts. Never guess unreadable text."}, {"type": "file", "file": {"filename": "notes.pdf", "file_data": f"data:application/pdf;base64,{encoded}"}}]}]}
    try:
        text = _post(payload, timeout=max(OPENROUTER_VISION_TIMEOUT, 12))["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise AITutorError("PDF OCR returned an unexpected response") from exc
    if not text:
        raise AITutorError("No readable notes were found in that PDF")
    return text[:120000]

def generate_question(*, course: str, unit: str, source_labels: list[str], focus: str, difficulty: int, personalization: dict[str, Any], source_text: str = "") -> dict[str, str]:
    grounded = bool(source_text.strip())
    prompt = "You are bindet's fast expert quiz writer. Create ONE concise short-answer question. Personalize difficulty. " + ("The supplied note excerpts are primary ground truth: test content actually present there and do not add unsupported facts. " if grounded else "Use course/unit knowledge; filenames are hints only. ") + "Return ONLY JSON: {\"question\":string,\"correct_answer\":string,\"topic\":string}."
    schema = {"type": "object", "additionalProperties": False, "properties": {"question": {"type": "string"}, "correct_answer": {"type": "string"}, "topic": {"type": "string"}}, "required": ["question", "correct_answer", "topic"]}
    result = _chat_json(system_prompt=prompt, temperature=0.3, max_tokens=220, schema_name="quiz_question", schema=schema, data={"course": course or "General Studies", "unit": unit or "Current Unit", "sources": source_labels[:10], "note_excerpts": source_text[:12000] if grounded else "", "focus": focus, "difficulty": difficulty, "performance": personalization})
    required = {"question", "correct_answer", "topic"}
    if set(result.keys()) != required or not all(isinstance(result[key], str) and result[key].strip() for key in required):
        raise AITutorError("AI question response did not match the required schema")
    return {key: result[key].strip() for key in required}

def generate_flashcards(*, course: str, unit: str, source_labels: list[str], count: int, personalization: dict[str, Any], source_text: str = "") -> list[dict[str, str]]:
    grounded = bool(source_text.strip())
    prompt = "You are bindet's expert flashcard writer. Make high-value retrieval-practice cards. Avoid duplicates and trivia. " + ("Use the supplied note excerpts as primary ground truth and do not invent unsupported details. " if grounded else "Filenames are hints only. ") + "Return ONLY JSON {\"cards\":[{\"front\":string,\"back\":string,\"topic\":string}]} ."
    requested = max(3, min(30, count))
    card_schema = {"type": "object", "additionalProperties": False, "properties": {"front": {"type": "string"}, "back": {"type": "string"}, "topic": {"type": "string"}}, "required": ["front", "back", "topic"]}
    schema = {"type": "object", "additionalProperties": False, "properties": {"cards": {"type": "array", "items": card_schema}}, "required": ["cards"]}
    result = _chat_json(system_prompt=prompt, temperature=0.3, max_tokens=min(1800, 110 * requested), schema_name="flashcard_deck", schema=schema, data={"course": course or "General Studies", "unit": unit or "Current Unit", "sources": source_labels[:10], "note_excerpts": source_text[:12000] if grounded else "", "count": requested, "performance": personalization})
    if set(result.keys()) != {"cards"} or not isinstance(result["cards"], list):
        raise AITutorError("AI flashcard response did not match the required schema")
    cards = []
    for raw in result["cards"]:
        if not isinstance(raw, dict) or set(raw.keys()) != {"front", "back", "topic"} or not all(isinstance(raw.get(k), str) and raw[k].strip() for k in ("front", "back", "topic")):
            raise AITutorError("AI returned an invalid flashcard")
        cards.append({key: raw[key].strip() for key in ("front", "back", "topic")})
    if len(cards) < 3:
        raise AITutorError("AI returned too few flashcards")
    return cards[:requested]

def grade_answer(*, question: str, correct_answer: str, student_answer: str, topic: str, difficulty: int) -> dict[str, Any]:
    prompt = "You are bindet's fast school tutor/grader. Use the reference as a rubric; accept equivalent wording and meaningful partial credit. Be concise. Return ONLY JSON with keys correct:boolean, score:0-100 integer, mistake_type:string|null, explanation:string, hint:string|null, misconception:string|null."
    nullable_string = {"anyOf": [{"type": "string"}, {"type": "null"}]}
    schema = {"type": "object", "additionalProperties": False, "properties": {"correct": {"type": "boolean"}, "score": {"type": "integer"}, "mistake_type": nullable_string, "explanation": {"type": "string"}, "hint": nullable_string, "misconception": nullable_string}, "required": ["correct", "score", "mistake_type", "explanation", "hint", "misconception"]}
    result = _chat_json(system_prompt=prompt, temperature=0.05, max_tokens=260, schema_name="answer_grade", schema=schema, data={"topic": topic, "difficulty": difficulty, "question": question, "reference": correct_answer, "answer": student_answer})
    required = {"correct", "score", "mistake_type", "explanation", "hint", "misconception"}
    if set(result.keys()) != required or not isinstance(result["correct"], bool):
        raise AITutorError("AI response did not match the required schema")
    try:
        result["score"] = max(0, min(100, int(result["score"])))
    except (TypeError, ValueError) as exc:
        raise AITutorError("AI returned an invalid score") from exc
    for key in ("mistake_type", "explanation", "hint", "misconception"):
        if result[key] is not None and not isinstance(result[key], str):
            raise AITutorError(f"AI returned invalid {key}")
    if not result["explanation"]:
        raise AITutorError("AI returned an empty explanation")
    return result
