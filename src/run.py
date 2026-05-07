"""Runtime: takes an idea, runs the agent against the rubric, returns a URL.

Per-request flow:
1. Load agent_id / env_id from setup.json
2. Create a new session
3. Open the event stream FIRST, then send user.define_outcome with the rubric
4. Stream events:
   - text → print
   - agent.custom_tool_use(deploy_site) → run Netlify deploy host-side, send result back
   - status_idle with terminal stop_reason OR status_terminated → break
5. Return the most recent deploy URL
"""
import json
import os
import sys
import time
from pathlib import Path

import anthropic

PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from src.analytics import capture, new_run_id  # noqa: E402

# Pick deploy backend by env. Default = netlify; set DEPLOY_BACKEND=vercel to switch.
_BACKEND = os.environ.get("DEPLOY_BACKEND", "netlify").lower()
if _BACKEND == "vercel":
    from src.deploy_vercel import deploy_html  # noqa: E402
else:
    from src.deploy import deploy_html  # noqa: E402

SETUP_FILE = PROJECT_ROOT / "setup.json"
RUBRIC_FILE = PROJECT_ROOT / "src" / "rubric.md"

def _terminal_idle(event) -> bool:
    """True if session.status_idle with a terminal stop_reason (NOT requires_action)."""
    if getattr(event, "type", None) != "session.status_idle":
        return False
    stop = getattr(event, "stop_reason", None)
    if stop is None:
        return True
    stop_type = getattr(stop, "type", None) if not isinstance(stop, dict) else stop.get("type")
    return stop_type != "requires_action"


def generate_landing_page(idea: str, max_iterations: int = 4) -> str:
    if not SETUP_FILE.exists():
        raise SystemExit("setup.json not found — run scripts/setup.py first.")
    cfg = json.loads(SETUP_FILE.read_text())
    rubric = RUBRIC_FILE.read_text()

    client = anthropic.Anthropic()
    run_id = new_run_id()
    run_started_at = time.time()

    print(f"Creating session for idea: {idea!r}")
    session = client.beta.sessions.create(
        agent=cfg["agent_id"],
        environment_id=cfg["environment_id"],
        title=f"landing: {idea[:60]}",
    )
    print(f"  session_id = {session.id}")
    print(f"  run_id     = {run_id}\n")

    capture("agent_run_started", run_id, {
        "idea": idea,
        "session_id": session.id,
        "agent_id": cfg["agent_id"],
        "environment_id": cfg["environment_id"],
        "max_iterations": max_iterations,
    })

    description = (
        f"Generate and deploy a landing page for the following idea:\n\n"
        f"{idea}\n\n"
        f"Iterate against the rubric until it is satisfied. Call deploy_site "
        f"on each iteration with the latest HTML. The final URL must be a "
        f"working .netlify.app site that satisfies every rubric criterion."
    )

    deployed_url = {"value": None}
    iteration_count = {"value": 0}

    def send_custom_tool_result(event, text: str, is_error: bool = False) -> None:
        payload = {
            "type": "user.custom_tool_result",
            "custom_tool_use_id": event.id,
            "content": [{"type": "text", "text": text}],
        }
        if is_error:
            payload["is_error"] = True
        client.beta.sessions.events.send(session_id=session.id, events=[payload])

    def handle_custom_tool(event) -> None:
        """Run the deploy host-side and post back the result."""
        tool_name = getattr(event, "name", None) or getattr(event, "tool_name", None)
        if tool_name != "deploy_site":
            err = f"unknown custom tool: {tool_name}"
            print(f"[tool error] {err}")
            send_custom_tool_result(event, err, is_error=True)
            return

        tool_input = getattr(event, "input", None) or {}
        if not isinstance(tool_input, dict):
            tool_input = (
                tool_input.model_dump()
                if hasattr(tool_input, "model_dump")
                else {}
            )

        html = tool_input.get("html", "")
        title = tool_input.get("title", "site")
        iteration_count["value"] += 1
        iter_n = iteration_count["value"]
        print(f"[deploy] iter {iter_n} | {len(html):,} bytes -> netlify ({title}) ...")
        try:
            result = deploy_html(html=html, title=title)
            deployed_url["value"] = result["url"]
            msg = (
                f"Deployment succeeded.\n"
                f"URL: {result['url']}\n"
                f"site_id: {result['site_id']}\n"
                f"name: {result['name']}\n"
                f"The page is now live. The grader can fetch this URL to verify "
                f"the deployed artifact. Wait for the grader's verdict."
            )
            print(f"[deploy] -> {result['url']}")
            send_custom_tool_result(event, msg)
            capture("agent_iteration_deployed", run_id, {
                "iteration": iter_n,
                "url": result["url"],
                "site_id": result["site_id"],
                "name": result["name"],
                "html_bytes": len(html),
                "title": title,
                "session_id": session.id,
                "elapsed_seconds": round(time.time() - run_started_at, 2),
            })
        except Exception as exc:
            print(f"[deploy ERROR] {exc}")
            send_custom_tool_result(event, f"Deployment failed: {exc}", is_error=True)
            capture("agent_iteration_deploy_failed", run_id, {
                "iteration": iter_n,
                "error_type": type(exc).__name__,
                "error_message": str(exc)[:500],
                "title": title,
                "html_bytes": len(html),
                "session_id": session.id,
            })

    session_error = {"value": None}

    # Stream-first: open the stream BEFORE sending the kickoff event, otherwise
    # early events may arrive buffered as a single batch.
    with client.beta.sessions.events.stream(session_id=session.id) as stream:
        client.beta.sessions.events.send(
            session_id=session.id,
            events=[{
                "type": "user.define_outcome",
                "description": description,
                "rubric": {"type": "text", "content": rubric},
                "max_iterations": max_iterations,
            }],
        )

        for event in stream:
            etype = getattr(event, "type", "?")

            # Print agent text for visibility
            if etype == "agent.message":
                content = getattr(event, "content", None) or []
                for block in content:
                    btype = getattr(block, "type", None) or (
                        block.get("type") if isinstance(block, dict) else None
                    )
                    if btype == "text":
                        text = getattr(block, "text", None) or block.get("text", "")
                        if text:
                            print(text, end="", flush=True)
                continue

            # Handle custom tool calls — session goes idle waiting for our reply
            if etype == "agent.custom_tool_use":
                # processed_at == None means queued; only act on processed events
                if getattr(event, "processed_at", None) is None:
                    continue
                # Grader runs in its own thread and may issue tool calls as
                # internal probes. Those are NOT for us to fulfill — responding
                # on the main session would 400, and not responding doesn't
                # block: the grader resolves its own thread internally.
                if getattr(event, "session_thread_id", None) is not None:
                    print(f"\n[skip] grader-thread tool call ({event.name}); ignoring")
                    continue
                print()  # newline after any preceding agent text
                handle_custom_tool(event)
                continue

            # Status transitions
            if etype == "session.error":
                session_error["value"] = repr(event)
                print(f"\n[event] {etype}: {session_error['value']}")
                break
            if etype == "session.status_terminated":
                print(f"\n[status] terminated")
                break
            if _terminal_idle(event):
                stop = getattr(event, "stop_reason", None)
                stop_type = (
                    getattr(stop, "type", None)
                    if stop is not None and not isinstance(stop, dict)
                    else (stop or {}).get("type")
                )
                print(f"\n[status] idle (terminal: stop_reason={stop_type})")
                break

            # Less noisy log of other interesting events
            if etype in (
                "session.status_running",
                "agent.thread_context_compacted",
            ):
                print(f"\n[event] {etype}")

    duration_s = round(time.time() - run_started_at, 2)

    if session_error["value"]:
        capture("agent_run_failed", run_id, {
            "session_id": session.id,
            "iterations": iteration_count["value"],
            "duration_seconds": duration_s,
            "failure": "session_error",
            "session_error": session_error["value"][:500],
            "last_url": deployed_url["value"],
        })
        raise SystemExit(f"Session error: {session_error['value']}")
    if not deployed_url["value"]:
        capture("agent_run_failed", run_id, {
            "session_id": session.id,
            "iterations": iteration_count["value"],
            "duration_seconds": duration_s,
            "failure": "no_deploy",
        })
        raise SystemExit("Session ended without a successful deployment.")

    capture("agent_run_completed", run_id, {
        "session_id": session.id,
        "iterations": iteration_count["value"],
        "duration_seconds": duration_s,
        "final_url": deployed_url["value"],
        "idea": idea,
    })
    return deployed_url["value"]
