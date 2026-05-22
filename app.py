import json
import os
from pathlib import Path
from time import time

from flask import Flask, jsonify, request, send_from_directory
from openai import OpenAI
from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR
load_dotenv(BASE_DIR / ".env")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
RATE_LIMIT_WINDOW_SECONDS = int(os.getenv("RATE_LIMIT_WINDOW_SECONDS", "300"))
RATE_LIMIT_MAX_REQUESTS = int(os.getenv("RATE_LIMIT_MAX_REQUESTS", "5"))
REQUEST_LOG = {}


app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="")


def is_rate_limited(client_id: str) -> bool:
    now = time()
    window_start = now - RATE_LIMIT_WINDOW_SECONDS
    recent_requests = [
        timestamp for timestamp in REQUEST_LOG.get(client_id, []) if timestamp >= window_start
    ]
    REQUEST_LOG[client_id] = recent_requests

    if len(recent_requests) >= RATE_LIMIT_MAX_REQUESTS:
        return True

    recent_requests.append(now)
    REQUEST_LOG[client_id] = recent_requests
    return False


def build_prompt(user_story: str, test_type: str) -> str:
    return f"""
You are a QA expert.

Generate detailed test cases from the user story below.

Return only valid JSON with this exact shape:
{{
  "testCases": [
    {{
      "testId": "TC-001",
      "scenario": "...",
      "precondition": "...",
      "steps": ["...", "..."],
      "expectedResult": "...",
      "priority": "High"
    }}
  ]
}}

Rules:
- Include positive, negative, and edge coverage where relevant.
- Cover validation and error scenarios.
- Keep priorities limited to High, Medium, or Low.
- Keep steps actionable and concise.
- Tailor the output to this requested focus: {test_type}.
- Generate at least 8 test cases unless the story is too small.
- Do not include markdown, explanations, or code fences.

User Story:
{user_story}
""".strip()


def build_assistant_prompt(user_input: str) -> str:
    return f"""
You are a helpful AI assistant in a small web app.

Respond clearly and directly to the user's request.
- Keep the answer practical and easy to read.
- Use short paragraphs or bullets when helpful.
- Do not include markdown code fences unless the user asks for code.

User input:
{user_input}
""".strip()


def build_assistant_messages(user_input: str, history: list[dict]) -> list[dict]:
    messages = [
        {
            "role": "system",
            "content": (
                "You are a practical assistant helping users in a web app. "
                "Answer clearly, directly, and helpfully."
            ),
        }
    ]

    for entry in history:
        role = entry.get("role")
        content = (entry.get("content") or "").strip()
        if role not in {"user", "assistant"} or not content:
            continue
        messages.append({"role": role, "content": content})

    messages.append({"role": "user", "content": build_assistant_prompt(user_input)})
    return messages


@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.post("/generate-testcases")
def generate_testcases():
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return jsonify({"error": "OPENAI_API_KEY is not configured on the server."}), 500

    client_id = request.headers.get("X-Forwarded-For", request.remote_addr or "anonymous")
    if is_rate_limited(client_id):
        return jsonify({"error": "Rate limit exceeded. Please wait a few minutes and try again."}), 429

    payload = request.get_json(silent=True) or {}
    user_story = (payload.get("userStory") or "").strip()
    test_type = (payload.get("testType") or "Functional").strip()

    if not user_story:
        return jsonify({"error": "User story is required."}), 400

    client = OpenAI(api_key=api_key)

    try:
        completion = client.chat.completions.create(
            model=OPENAI_MODEL,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": "You generate structured QA test cases in strict JSON.",
                },
                {
                    "role": "user",
                    "content": build_prompt(user_story, test_type),
                },
            ],
        )
        content = completion.choices[0].message.content or "{}"
        data = json.loads(content)
        test_cases = data.get("testCases")

        if not isinstance(test_cases, list):
            raise ValueError("Model response did not include a testCases array.")

        normalized = []
        for index, test_case in enumerate(test_cases, start=1):
            steps = test_case.get("steps") or []
            if isinstance(steps, list):
                step_text = "\n".join(
                    f"{step_index}. {step}" for step_index, step in enumerate(steps, start=1)
                )
            else:
                step_text = str(steps)

            normalized.append(
                {
                    "testId": test_case.get("testId") or f"TC-{index:03d}",
                    "scenario": test_case.get("scenario") or "",
                    "precondition": test_case.get("precondition") or "",
                    "steps": step_text,
                    "expectedResult": test_case.get("expectedResult") or "",
                    "priority": test_case.get("priority") or "Medium",
                }
            )

        return jsonify({"testCases": normalized})
    except Exception as exc:
        return jsonify({"error": f"Failed to generate test cases: {exc}"}), 502


@app.post("/ask-ai")
def ask_ai():
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return jsonify({"error": "OPENAI_API_KEY is not configured on the server."}), 500

    client_id = request.headers.get("X-Forwarded-For", request.remote_addr or "anonymous")
    if is_rate_limited(client_id):
        return jsonify({"error": "Rate limit exceeded. Please wait a few minutes and try again."}), 429

    payload = request.get_json(silent=True) or {}
    user_input = (payload.get("message") or "").strip()
    history = payload.get("history") or []

    if not user_input:
        return jsonify({"error": "Message is required."}), 400

    if not isinstance(history, list):
        return jsonify({"error": "History must be an array."}), 400

    client = OpenAI(api_key=api_key)

    try:
        completion = client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=build_assistant_messages(user_input, history[-12:]),
        )
        content = completion.choices[0].message.content or ""
        return jsonify({"answer": content.strip()})
    except Exception as exc:
        return jsonify({"error": f"Failed to get AI response: {exc}"}), 502


@app.get("/<path:path>")
def static_files(path: str):
    return send_from_directory(STATIC_DIR, path)


if __name__ == "__main__":
    app.run(debug=True)