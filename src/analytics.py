"""Server-side PostHog capture for the agent build pipeline.

Captures process-level events: when a generation run starts, each iteration
deploy, the grader's verdict, and the final outcome. Mirrors the client-side
landing-page events so PostHog has end-to-end visibility (idea → deploy →
final URL → user clicks).

Fails silently — analytics outages should never break the build.
"""
from __future__ import annotations

import os
import time
import uuid
from typing import Any

import requests

_HOST = os.environ.get("POSTHOG_HOST", "https://us.i.posthog.com")


def _key() -> str | None:
    return os.environ.get("POSTHOG_PROJECT_KEY")


def capture(event: str, distinct_id: str, properties: dict[str, Any] | None = None) -> None:
    """Fire a PostHog event. Never raises — best effort only."""
    api_key = _key()
    if not api_key:
        return
    payload = {
        "api_key": api_key,
        "event": event,
        "distinct_id": distinct_id,
        "properties": {
            **(properties or {}),
            "$lib": "kilolandingagent-orchestrator",
            "ts_unix": int(time.time()),
        },
    }
    try:
        requests.post(f"{_HOST}/capture/", json=payload, timeout=5)
    except Exception:
        # Analytics outages must not break the build.
        pass


def new_run_id() -> str:
    """Stable distinct_id for a single agent run, used across all events."""
    return f"run_{uuid.uuid4().hex[:12]}"
