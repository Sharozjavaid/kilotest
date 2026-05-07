"""One-time setup: create the environment and agent, persist IDs to setup.json.

Run once. Subsequent runs of run.py reuse the IDs. If you change the system
prompt or tool schema, re-run this — it'll create a new version.
"""
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

load_dotenv(PROJECT_ROOT / ".env")

import anthropic

SETUP_FILE = PROJECT_ROOT / "setup.json"

POSTHOG_KEY = os.environ["POSTHOG_PROJECT_KEY"]
POSTHOG_HOST = os.environ.get("POSTHOG_HOST", "https://us.i.posthog.com")

SYSTEM_PROMPT = f"""You are an autonomous landing page generator. Given an
idea for a product or service, you produce a complete, self-contained
single-file `index.html` and deploy it via the `deploy_site` tool.

## Your process

1. Read the idea and the success rubric carefully.
2. Generate a single complete HTML document that satisfies the rubric.
3. Call `deploy_site` exactly once per iteration with the full HTML and a
   short slug for the site name (lowercase, hyphenated, derived from the idea).
4. Wait for the grader's verdict. If the rubric is not yet met, revise the
   HTML and call `deploy_site` again with the new version.

## Hard requirements (the grader will fail you otherwise)

- Single self-contained file. ALL CSS inline in `<style>`. ALL JS inline in
  `<script>`. The only external script tag allowed is the PostHog snippet.
- Include this exact PostHog snippet in `<head>`, with the project key
  already filled in:

```html
<script>
!function(t,e){{var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){{function g(t,e){{var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){{t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){{var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e}},u.people.toString=function(){{return u.toString(1)+".people (stub)"}},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])}},e.__SV=1)}}(document,window.posthog||[]);
posthog.init('{POSTHOG_KEY}', {{api_host:'{POSTHOG_HOST}'}})
</script>
```

- Include the analytics-wiring `<script>` block below at the END of `<body>`
  (immediately before `</body>`). It captures a comprehensive set of events
  for a full PostHog funnel: page load metadata, scroll depth thresholds,
  per-CTA visibility and clicks, per-section visibility, external links,
  visible-time heartbeat, and unload duration. ALL of these events are
  required by the rubric — do not omit any.

```html
<script>
(function() {{
  var ph = function() {{ return window.posthog; }};
  // page_loaded with viewport / referrer / screen
  document.addEventListener('DOMContentLoaded', function() {{
    if (!ph()) return;
    ph().capture('page_loaded', {{
      path: window.location.pathname,
      referrer: document.referrer || null,
      viewport_w: window.innerWidth,
      viewport_h: window.innerHeight,
      screen_w: window.screen ? window.screen.width : null,
      screen_h: window.screen ? window.screen.height : null,
    }});
  }});

  // delegated cta_clicked + external_link_click
  document.addEventListener('click', function(e) {{
    var ctaEl = e.target.closest('[data-cta]');
    if (ctaEl && ph()) {{
      var sec = ctaEl.closest('[data-section]');
      ph().capture('cta_clicked', {{
        cta: ctaEl.getAttribute('data-cta'),
        section: sec ? sec.getAttribute('data-section') : null,
      }});
    }}
    var linkEl = e.target.closest('a[href]');
    if (linkEl && ph()) {{
      var href = linkEl.getAttribute('href');
      if (/^https?:\\/\\//.test(href) && linkEl.host !== window.location.host) {{
        ph().capture('external_link_click', {{
          href: href,
          text: (linkEl.textContent || '').trim().slice(0, 80),
        }});
      }}
    }}
  }});

  // cta_viewed and section_viewed via IntersectionObserver (fire once each)
  if ('IntersectionObserver' in window) {{
    var seenCtas = new Set();
    var ctaObserver = new IntersectionObserver(function(entries) {{
      entries.forEach(function(entry) {{
        if (entry.intersectionRatio < 0.5) return;
        var el = entry.target;
        var cta = el.getAttribute('data-cta');
        if (seenCtas.has(cta)) return;
        seenCtas.add(cta);
        var sec = el.closest('[data-section]');
        if (ph()) ph().capture('cta_viewed', {{
          cta: cta,
          section: sec ? sec.getAttribute('data-section') : null,
        }});
      }});
    }}, {{ threshold: 0.5 }});
    document.querySelectorAll('[data-cta]').forEach(function(el) {{ ctaObserver.observe(el); }});

    var seenSecs = new Set();
    var secObserver = new IntersectionObserver(function(entries) {{
      entries.forEach(function(entry) {{
        if (entry.intersectionRatio < 0.5) return;
        var sec = entry.target.getAttribute('data-section');
        if (seenSecs.has(sec)) return;
        seenSecs.add(sec);
        if (ph()) ph().capture('section_viewed', {{ section: sec }});
      }});
    }}, {{ threshold: 0.5 }});
    document.querySelectorAll('[data-section]').forEach(function(el) {{ secObserver.observe(el); }});
  }}

  // scroll_depth at 25 / 50 / 75 / 100
  var thresholds = [25, 50, 75, 100];
  var firedDepths = new Set();
  var maxDepth = 0;
  function checkScroll() {{
    var doc = document.documentElement;
    var total = doc.scrollHeight - window.innerHeight;
    if (total <= 0) return;
    var pct = Math.min(100, Math.round(((window.scrollY || doc.scrollTop) / total) * 100));
    if (pct > maxDepth) maxDepth = pct;
    thresholds.forEach(function(t) {{
      if (pct >= t && !firedDepths.has(t)) {{
        firedDepths.add(t);
        if (ph()) ph().capture('scroll_depth', {{ depth: t }});
      }}
    }});
  }}
  window.addEventListener('scroll', checkScroll, {{ passive: true }});

  // visible-time heartbeat
  var visibleSeconds = 0;
  var heartbeat = null;
  function startHeartbeat() {{
    if (heartbeat) return;
    heartbeat = setInterval(function() {{
      visibleSeconds += 15;
      if (ph()) ph().capture('page_engaged', {{ seconds_on_page: visibleSeconds }});
    }}, 15000);
  }}
  function stopHeartbeat() {{
    if (heartbeat) {{ clearInterval(heartbeat); heartbeat = null; }}
  }}
  if (document.visibilityState === 'visible') startHeartbeat();
  document.addEventListener('visibilitychange', function() {{
    if (document.visibilityState === 'visible') startHeartbeat(); else stopHeartbeat();
  }});

  // page_unload via pagehide (with beforeunload fallback)
  function fireUnload() {{
    if (!ph()) return;
    ph().capture('page_unload', {{
      seconds_on_page: visibleSeconds,
      max_scroll_depth: maxDepth,
    }});
  }}
  window.addEventListener('pagehide', fireUnload);
  window.addEventListener('beforeunload', fireUnload);
}})();
</script>
```

- Every clickable CTA (button or link) MUST have a `data-cta` attribute with
  a short slug describing the action: `data-cta="hero-signup"`,
  `data-cta="footer-contact"`, etc.

- Every major section element MUST have a `data-section` attribute:
  `data-section="hero"`, `data-section="features"`, `data-section="pricing"`,
  `data-section="cta-final"`, `data-section="footer"`, etc.

- Use a coherent 3-color palette. No clashing. Use CSS custom properties.

- Be specific in copy. Name the user. Name the outcome. No marketing puffery
  ("revolutionary", "next-gen", "leverage synergies", "game-changing").

## When you're satisfied

Call `deploy_site(html=..., title=...)`. The tool returns a public URL (on
either `.netlify.app` or `.vercel.app` depending on the configured backend).
The grader will evaluate the deployed page against the rubric.

If the grader says the rubric is met, your work is done — produce a brief
final message confirming the URL.
"""

DEPLOY_TOOL = {
    "type": "custom",
    "name": "deploy_site",
    "description": (
        "Deploys a complete HTML document as a static site to Netlify and "
        "returns the public URL. Call this once per iteration with the "
        "current full HTML."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "html": {
                "type": "string",
                "description": "The complete HTML document, starting with <!DOCTYPE html>.",
            },
            "title": {
                "type": "string",
                "description": (
                    "A short, lowercase-hyphenated slug for the site name "
                    "(e.g. 'meal-planner-ai'). Used in the public URL."
                ),
            },
        },
        "required": ["html", "title"],
    },
}


def main() -> None:
    client = anthropic.Anthropic()

    print("Creating environment ...")
    env = client.beta.environments.create(
        name=f"landing-page-agent-{os.urandom(4).hex()}",
        config={"type": "cloud", "networking": {"type": "limited", "allowed_hosts": []}},
    )
    print(f"  env_id = {env.id}")

    print("Creating agent ...")
    agent = client.beta.agents.create(
        name="Landing Page Generator",
        model="claude-opus-4-7",
        system=SYSTEM_PROMPT,
        tools=[DEPLOY_TOOL],
    )
    print(f"  agent_id = {agent.id}")
    print(f"  version  = {agent.version}")

    SETUP_FILE.write_text(
        json.dumps(
            {
                "agent_id": agent.id,
                "agent_version": agent.version,
                "environment_id": env.id,
            },
            indent=2,
        )
    )
    print(f"\nWrote {SETUP_FILE}")


if __name__ == "__main__":
    main()
