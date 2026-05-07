# Landing Page Quality Rubric

The artifact under evaluation is a single self-contained `index.html` document.
The agent is required to call the `deploy_site` tool with the final HTML; the
grader evaluates the HTML that was passed to the most recent `deploy_site`
call.

## Structure (must pass all)

- The page opens with `<!DOCTYPE html>` and is valid HTML5
- Includes `<meta name="viewport" content="width=device-width, initial-scale=1">` in `<head>`
- Has a clear hero section at the top with: a headline, a subheadline / supporting line, and at least one CTA button
- Has a features or benefits section with at least 3 distinct items, each in its own element with `data-section="features"` (or similar `data-section` attribute on the section wrapper)
- Has a secondary CTA section (the primary CTA is repeated near the bottom)
- Has a footer with at least one piece of contact information or a copyright line
- Each major section (hero, features, pricing/CTA mid-page, testimonials/FAQ if present, final CTA, footer) has a `data-section="<slug>"` attribute on its outer element

## Copy quality (must pass all)

- The headline names a specific user or use case and a specific outcome — not abstract puffery
- No filler phrases: avoid "revolutionary", "next-gen", "cutting-edge", "leverage synergies", "game-changing", "world-class"
- Each feature item is a concrete benefit phrased in plain language, not jargon
- Tone is consistent throughout (don't mix corporate-stiff with casual-meme)

## CTA & Analytics — comprehensive (must pass all)

The page must instrument every meaningful user signal so PostHog can build a
full conversion funnel and engagement picture. The grader will inspect the
JavaScript for the following events; missing any is a fail.

### Required PostHog events fired from the page

| Event | When it fires | Required properties |
|---|---|---|
| `page_loaded` | On `DOMContentLoaded` | `path`, `referrer`, `viewport_w`, `viewport_h`, `screen_w`, `screen_h` |
| `cta_clicked` | On click of any `[data-cta]` element (delegated) | `cta` (the slug), `section` (nearest `[data-section]` ancestor) |
| `cta_viewed` | First time each `[data-cta]` element enters the viewport (≥50% visible) — fire ONCE per CTA | `cta`, `section` |
| `section_viewed` | First time each `[data-section]` element enters the viewport (≥50% visible) — fire ONCE per section | `section` |
| `scroll_depth` | When the user passes 25%, 50%, 75%, 100% of total page height — each threshold fires ONCE | `depth` (one of `25`, `50`, `75`, `100`) |
| `external_link_click` | On click of any `<a>` whose href is an absolute URL to a different origin | `href`, `text` (link text) |
| `page_engaged` | Heartbeat every 15 seconds while the tab is visible | `seconds_on_page` (cumulative) |
| `page_unload` | On `pagehide` (preferred) or `beforeunload` fallback | `seconds_on_page`, `max_scroll_depth` |

### Implementation requirements

- The PostHog `<script>` snippet is present in `<head>` and uses the project key provided in the agent's instructions
- Event-firing JavaScript is in a single `<script>` block placed at the very end of `<body>` (just before `</body>`)
- The script uses `document.addEventListener` and `IntersectionObserver` (available in all evergreen browsers) — do NOT rely on jQuery or any external library
- `cta_viewed` and `section_viewed` use IntersectionObserver with `threshold: 0.5` and `once`-style firing (track which IDs have already fired and don't double-fire)
- Heartbeat uses `setInterval` plus a `document.visibilitychange` listener so it pauses when the tab is hidden
- `page_unload` uses `pagehide` event with `event.persisted` check, and falls back to `beforeunload` for older browsers
- All `posthog.capture()` calls are guarded with `if (window.posthog)` so the page works even if the snippet is blocked

### CTA & section attribute requirements

- Every clickable CTA element has `data-cta="<slug>"` (e.g. `data-cta="hero-signup"`, `data-cta="footer-contact"`)
- Every major section element has `data-section="<slug>"` (e.g. `data-section="hero"`, `data-section="features"`, `data-section="pricing"`, `data-section="cta-final"`, `data-section="footer"`)

## Technical (must pass all)

- All CSS is inline in `<style>` blocks (no external stylesheets)
- All JS is inline in `<script>` blocks (no external scripts other than the PostHog snippet)
- Uses a coherent 3-color palette — primary, accent, neutral. Colors don't clash.
- Total document size is under 100 KB
- No broken or placeholder content (no "lorem ipsum", no `TODO`, no empty `href="#"` without a valid behavior)
- Works as a standalone file — opening the HTML in a browser would render correctly without any other assets

## Deployment (must pass)

- The `deploy_site` tool was successfully called during this iteration
- The tool returned a public URL on `.netlify.app` or `.vercel.app`
- The HTML passed to `deploy_site` matches the artifact being graded
