# Build status — what's working, what's not, where to look

## TL;DR

You're right that the building blocks work. **Netlify deploy works. Managed
Agents works. The agent generates real, on-rubric HTML.** All the bugs we've
hit are at the seams between the two systems — the kind of issues you only
find at runtime, not in the docs.

The current run is in flight. If it completes cleanly with all fixes in
place, we're done.

## What's confirmed working

| Piece | Verified by |
|---|---|
| Anthropic API key + Managed Agents beta access | `client.beta.environments.list()` returned 200 |
| Agent creation (`agent_011CamnvuqdXM8xZFtoH8nA4`) + environment | `setup.json` has the IDs, agent.version=1 |
| Netlify token + zip deploy | `https://headers-fix-test-1778093299.netlify.app` renders correctly |
| Agent generates real on-rubric HTML | The previous run produced ~32 KB of landing-page HTML for "ChowChart" — named user (Maya at UCLA), concrete prices ($46.50/wk), real grocery stores, every CTA had `data-cta`, PostHog snippet present |
| Defined-outcomes loop is initiating (grader spinning up) | Session events log shows `span.outcome_evaluation_start` |

## Hiccups we've hit and how they were fixed

### 1. Beta header wrong on send/stream — FIXED

Docs example used `managed-agents-2026-04-01-research-preview`. That header
returns 404 on both `events.send` and `events.stream`. The feature is now GA
under the standard `managed-agents-2026-04-01` header (which the SDK adds
automatically). **Fix:** removed the explicit `betas=` argument from all
calls in `src/run.py`.

### 2. Wrong attribute on tool_use event — FIXED

I assumed `event.tool_name`; the actual field is `event.name`. Caught only
when the agent first triggered the deploy tool (~3 min into the run).
**Fix:** `getattr(event, "name", ...)` in `handle_custom_tool` in
`src/run.py:67`.

### 3. Netlify zip deploys served as `text/plain` — FIXED

This was the bug you saw. Netlify's zip-deploy API doesn't reliably auto-
detect MIME types for single-file sites — it served valid HTML as plain
text, so the browser displayed source instead of rendering. **Fix:**
include a `_headers` file in the zip overriding the Content-Type:

```python
# src/deploy.py:30
headers_file = "/*\n  Content-Type: text/html; charset=utf-8\n"
z.writestr("_headers", headers_file)
```

Verified: `headers-fix-test-1778093299.netlify.app` now serves `text/html`.

### 4. Grader makes tool calls on its own session thread — FIXED

This was the most surprising one. When the grader runs, it gets its own
session thread (`session_thread_id` is set on its events) and **issues its
own tool calls** as internal probes — including a no-op `deploy_site`
call titled literally `"grader-probe-noop"`. We tried to respond on the
main thread and got a 400 ("tool_use_id does not match any custom_tool_use
event in this session"). **Fix:** detect `session_thread_id != None` and
skip — the grader resolves its own thread internally.

```python
# src/run.py:148
if getattr(event, "session_thread_id", None) is not None:
    continue
```

### 5. PostHog key is wrong type — NEEDS YOUR ACTION

The key you sent (`phx_…`) is a **Personal API Key**. PostHog rejects it
for the `/capture/` endpoint:

```
status: 401
body: API key is not valid: personal_api_key
```

We need a **Project API Key** (starts with `phc_`):

> PostHog dashboard → Project Settings → "Project API Key" → copy → paste
> into `.env` as `POSTHOG_PROJECT_KEY=phc_…`

**No code changes needed** — just swap the env var. The agent's HTML output
already wires the snippet correctly; the events just won't be accepted by
PostHog until the right key is in place.

## Where I'm still uncertain — the functions to scrutinize

These are the spots where I have residual doubt and where a bug, if there
is one, is most likely hiding.

### `src/run.py` → `_terminal_idle(event)` — line 32

Decides whether `session.status_idle` means "done" or "waiting for tool
result". I check `stop_reason.type != "requires_action"`, but the
`stop_reason` field comes back as a Pydantic model on the SDK and a dict
on raw HTTP — I handle both, but the field-name shape might shift on edge
cases (e.g., `retries_exhausted`, `end_turn`). **If the script hangs
forever after the agent has obviously finished, this is the function.**

### `src/run.py` → main `for event in stream:` loop — lines 130–185

I only explicitly handle `agent.message`, `agent.custom_tool_use`,
`session.status_running`, `session.status_terminated`, and the terminal
idle. **What I'm not handling:**

- `agent.thinking` — silently dropped, fine
- `agent.message_delta` (if exists) — might be missing live token streaming
- `session.error` — logged but doesn't break the loop. Should it?
- `agent.tool_use` (built-in agent toolset) — we don't enable the agent
  toolset, so this shouldn't fire. But if the agent ever changes config to
  include `agent_toolset_20260401`, those events would arrive un-handled.

**If the run terminates without a deploy URL but no error**, look here.

### `src/run.py` → `handle_custom_tool(event)` — lines 65–115

The post-back to `events.send` on success uses `custom_tool_use_id =
event.id`. The docs sample uses the same field name, so this should be
fine — but the 400 from issue #4 above was suspicious enough that if we
see a similar error on a main-thread tool call, this is the spot.

### `src/deploy.py` → `deploy_html()` — entire function

After the headers fix, this is solid. But:

- I'm using the `subdomain` field from the POST response to construct the
  canonical URL. If Netlify ever returns the response with `subdomain:
  None` (the GET response does this — see `name` instead), the URL will
  be wrong. There's a fallback (`subdomain or name or name-arg`), but I
  haven't load-tested it.
- The deploy provisioning takes ~2–5 seconds before the URL is live; we
  return immediately. If the grader fetches the URL the moment we
  respond, it might 404 once. The grader appears to retry, based on the
  `outcome_evaluation_ongoing` events, so this is probably fine.

## Where to look first if something breaks

| Symptom | Open this file/function |
|---|---|
| Agent generates HTML but URL is 404 | `src/deploy.py` `deploy_html()` — subdomain logic |
| Browser shows raw HTML source | `src/deploy.py` — verify `_headers` is in zip |
| Script crashes on first tool call | `src/run.py:67` — the event attribute names |
| Script hangs after agent says "Awaiting grader verdict" | `src/run.py:32` `_terminal_idle()` |
| 400 on `events.send` | `src/run.py:148` — grader-thread skip; verify it's actually skipping |
| Agent loops forever, never deploys | The system prompt in `scripts/setup.py` — re-running setup to bump version |
| Analytics events don't appear in PostHog | `.env` — `phx_` vs `phc_` key prefix |

## What I'd verify first when the run completes

1. Curl the returned URL — `Content-Type` should be `text/html`
2. Open in browser — landing page should render
3. View source — `posthog.init(...)` should be in `<head>`
4. Click a CTA button → check PostHog dashboard for `cta_clicked` event
   (after fixing the API key)
