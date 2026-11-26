/**
 * Manual check: renders a fixture manifest's ground-truth cut.
 *   npm run render -- --manifest ../../fixtures/out/routine/manifest.json --out .work/routine.mp4 [--quality preview] [--captions bold]
 */
import { resolve } from 'node:path';
import { CaptionStyle, RenderQuality } from '@kilo/edl';
import { fixtureInputs, standInRenderGraphic } from './dev/fixtures.js';
import { renderVideo } from './render.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const manifest = arg('--manifest');
  const out = arg('--out');
  if (!manifest || !out) {
    console.error('Usage: npm run render -- --manifest <manifest.json> --out <file.mp4> [--quality preview|final] [--captions clean|bold|karaoke]');
    process.exit(2);
  }
  const quality = RenderQuality.parse(arg('--quality') ?? 'final');
  const captionsArg = arg('--captions');
  const captions = captionsArg ? CaptionStyle.parse(captionsArg) : undefined;
  const work = resolve(import.meta.dirname, '..', '.work');
  const inputs = await fixtureInputs(manifest, resolve(work, 'norm'), { captions });
  const t0 = Date.now();
  let lastPct = -1;
  const res = await renderVideo({
    ...inputs,
    quality,
    outPath: resolve(out),
    workDir: resolve(work, 'cli'),
    renderGraphic: standInRenderGraphic,
    onProgress: (p) => {
      const pct = Math.floor(p * 20) * 5;
      if (pct !== lastPct) {
        lastPct = pct;
        process.stderr.write(`\r${pct}%   `);
      }
    },
  });
  const sec = (Date.now() - t0) / 1000;
  process.stderr.write('\n');
  console.log(`${res.outPath}: ${res.width}x${res.height} @ ${res.fps} fps, ${res.durationSec.toFixed(3)} s, rendered in ${sec.toFixed(1)} s`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
