# @kilo/templates

The five motion graphic templates (`bold-title`, `numbered-list`, `stat-callout`, `keyword-pop`, `price-tag`) and their renderer. Exports `templates: TemplatesApi` from `@kilo/edl`.

```ts
import { templates, shutdown } from '@kilo/templates';

await templates.renderGraphic({ template: 'stat-callout', props: { value: '10 sec', label: 'is all it takes' },
  theme, durationSec: 2, fps: 60, width: 1080, height: 1920, outPath: '/tmp/g.mov' });
// QuickTime ProRes 4444 (ap4h, yuva444p10le, bt709), exactly width x height, round(durationSec * fps) frames.
```

## How it renders

- Templates are React components (`src/remotion/`) rendered by **Remotion**. Layout is done on a 1080-wide design canvas and scaled to the output, so 540x960 previews lay out identically to 1080x1920 finals.
- Remotion captures each frame as a transparent PNG in headless Chromium; the frames are piped in order into the system `ffmpeg`, which encodes ProRes 4444 with the `prores_aw` encoder (same stream as `prores_ks`, about 2.5x faster; set `KILO_TEMPLATES_PRORES_ENCODER=prores_ks` to switch). Capture and encoding overlap.
- The Remotion project is bundled once per code version into the cache directory and reused by every later process. One headless browser is shared by all renders and closes itself after 15 s idle (`shutdown()` closes it at once).
- Text is measured in the page with the bundled fonts and wrapped into balanced lines by our own fitter (`src/remotion/fit.ts`), then drawn line by line, so what is measured is what is drawn. Every template auto-sizes to fit its schema's longest values inside the platform safe area (top 12%, bottom 22%, right 14% of the lower half).
- Output is cached on disk by a hash of the validated request plus a hash of the template sources, fonts and Remotion version. Identical requests return in milliseconds; identical concurrent requests share one render; concurrent renders are limited by a semaphore. Writes are atomic (temp file + rename).

## Environment

| Variable | Default | |
|---|---|---|
| `KILO_TEMPLATES_CACHE_DIR` | `$TMPDIR/kilo-templates-cache` | bundles, rendered graphics and stills. Not pruned automatically. |
| `KILO_CHROMIUM_PATH` | first `chromium_headless_shell-*` under `/opt/pw-browsers` or `~/.cache/ms-playwright` | Remotion downloads a browser only if none is found. |
| `KILO_TEMPLATES_PARALLEL` | 2 | graphics rendered at the same time |
| `KILO_TEMPLATES_CONCURRENCY` | min(4, cores) | browser tabs per graphic |
| `KILO_TEMPLATES_GL` | `swangle` | Chromium GL backend |
| `KILO_FFMPEG` | `ffmpeg` | |
| `REMOTION_LICENSE_KEY` | | passed to Remotion when set |

## Scripts

- `npm test`: renders every template and checks the files with ffprobe (codec, profile, pixel format, size, rate, exact frame count), transparency or opacity at mid-hold, the safe area on the longest/shortest text cases, prop validation, cache, determinism and concurrency.
- `npm run preview`: contact sheets in `.work/preview/<template>.png` (six moments across the duration, three themes, longest/shortest text) over a footage-like background with the safe-area guides in red. `-- --full` renders at 1080x1920@60, `-- --only=<id>` limits to one template.

## Licences

- **Remotion is not free for companies.** Its licence allows free use for individuals and companies of up to three people; any larger company needs a paid Remotion Company License before Kilo ships (see https://www.remotion.dev/license). Set `REMOTION_LICENSE_KEY` once there is one.
- Inter (`assets/fonts/`) is under the SIL Open Font License 1.1; the licence is in `assets/fonts/LICENSE.txt`.
