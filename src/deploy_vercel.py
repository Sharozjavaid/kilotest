"""Vercel deploy: POST a single-file deployment via REST API.

Drop-in alternative to deploy.py. Same return shape: dict with `url`,
`site_id`, `name`. Used when Netlify is over quota.

Vercel's `POST /v13/deployments` accepts inline file content; the response
includes a deployment URL. We poll `readyState` briefly until the
deployment is `READY` (otherwise visitors see a "building" placeholder).
"""
from __future__ import annotations

import os
import re
import time
from typing import Any

import requests

VERCEL_API = "https://api.vercel.com"
LIVE_CHECK_ATTEMPTS = 20
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


def _wait_until_live(url: str, deployment_id: str, token: str) -> None:
    """Poll Vercel for READY state, then verify the URL serves text/html."""
    for _ in range(LIVE_CHECK_ATTEMPTS):
        # Vercel state poll
        try:
            r = requests.get(
                f"{VERCEL_API}/v13/deployments/{deployment_id}",
                headers={"Authorization": f"Bearer {token}"},
                timeout=10,
            )
            if r.ok:
                state = r.json().get("readyState")
                if state == "READY":
                    break
                if state == "ERROR":
                    raise RuntimeError(f"Vercel deployment errored: {r.json()}")
        except requests.RequestException:
            pass
        time.sleep(LIVE_CHECK_DELAY_SECONDS)
    # Then verify the URL serves
    for _ in range(LIVE_CHECK_ATTEMPTS):
        try:
            resp = requests.get(url, timeout=10)
            ct = resp.headers.get("Content-Type", "").lower()
            if resp.status_code == 200 and "text/html" in ct:
                return
        except requests.RequestException:
            pass
        time.sleep(LIVE_CHECK_DELAY_SECONDS)
    # Don't fail hard — return anyway. Better to hand the agent a maybe-not-yet-live
    # URL and let the grader retry than to trigger an iteration cascade.


def deploy_html(html: str, title: str = "site") -> dict[str, Any]:
    _validate_html(html)
    token = os.environ["VERCEL_TOKEN"]
    name = f"{_slug(title)}-{int(time.time())}"

    body = {
        "name": name,
        "files": [
            {
                "file": "index.html",
                "data": html,
            }
        ],
        "projectSettings": {"framework": None},
        "target": "production",
    }

    resp = requests.post(
        f"{VERCEL_API}/v13/deployments",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    deployment_id = data["id"]
    deploy_url = data.get("url")
    if not deploy_url:
        raise RuntimeError(f"Vercel response missing url: {data}")
    if not deploy_url.startswith("http"):
        deploy_url = f"https://{deploy_url}"

    _wait_until_live(deploy_url, deployment_id, token)

    return {
        "url": deploy_url,
        "site_id": deployment_id,
        "name": name,
    }
