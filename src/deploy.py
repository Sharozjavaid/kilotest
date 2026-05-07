"""Netlify deploy: zip an HTML string and POST it. Runs host-side; the Netlify
token never enters the agent container."""
import io
import os
import re
import time
import zipfile

import requests

NETLIFY_API = "https://api.netlify.com/api/v1"
LIVE_CHECK_ATTEMPTS = 10
LIVE_CHECK_DELAY_SECONDS = 1.5


def _slug(title: str) -> str:
    s = re.sub(r"[^a-z0-9-]+", "-", title.lower()).strip("-")
    return (s or "site")[:40]


def _validate_html(html: str) -> None:
    if not isinstance(html, str) or not html.strip():
        raise ValueError("deploy_site requires a non-empty html string.")
    if "<!doctype html" not in html[:200].lower():
        raise ValueError("deploy_site html must start with a <!DOCTYPE html> document.")
    if "</html>" not in html.lower():
        raise ValueError("deploy_site html must include a closing </html> tag.")


def _wait_until_live(url: str) -> None:
    """Best-effort wait for Netlify provisioning. NEVER raises — liveness check
    failure must not trigger an agent retry cascade. The grader will fetch
    the URL itself and judge whether it's actually serving."""
    for _ in range(LIVE_CHECK_ATTEMPTS):
        try:
            resp = requests.get(url, timeout=10)
            content_type = resp.headers.get("Content-Type", "")
            if resp.status_code == 200 and "text/html" in content_type.lower():
                return
        except requests.RequestException:
            pass
        time.sleep(LIVE_CHECK_DELAY_SECONDS)
    # Soft return: the deploy POST already succeeded; the URL will likely be
    # live within seconds. Don't punish the agent for our liveness probe.


def deploy_html(html: str, title: str = "site") -> dict:
    _validate_html(html)
    token = os.environ["NETLIFY_TOKEN"]
    name = f"{_slug(title)}-{int(time.time())}"

    # Without a `_headers` override, Netlify zip-deploys serve single HTML
    # files as `text/plain` — browsers render the source as raw text. Forcing
    # text/html here fixes that.
    headers_file = "/*\n  Content-Type: text/html; charset=utf-8\n"

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("index.html", html)
        z.writestr("_headers", headers_file)
    buf.seek(0)

    resp = requests.post(
        f"{NETLIFY_API}/sites?name={name}",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/zip",
        },
        data=buf.getvalue(),
        timeout=60,
    )
    resp.raise_for_status()
    site = resp.json()
    subdomain = site.get("subdomain") or site.get("name") or name
    # Netlify's POST-with-zip response returns an http URL with a random
    # deploy-prefix (e.g. "http://abc123--my-site.netlify.app"); the clean
    # canonical https URL is "https://<subdomain>.netlify.app".
    url = f"https://{subdomain}.netlify.app"
    _wait_until_live(url)
    return {
        "url": url,
        "site_id": site["id"],
        "name": subdomain,
    }
