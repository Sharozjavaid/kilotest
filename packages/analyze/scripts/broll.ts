import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOOK_PROTECT_SEC, resolveTimeline, type BrollOverlay } from '@kilo/edl';
import { buildLines } from '../src/lines.js';
import { explainBroll } from '../src/overlays.js';
import { findFixtures, REPO, scoreFixture } from './scoring.js';

/**
 * Phase 3 proxy: "Placements are accepted without a swap most of the time."
 *
 * Whether a creator accepts a placement cannot be measured here. This is the closest
 * objective stand-in, and it runs with the OFFLINE describer (file name and probe
 * data) and the OFFLINE heuristic decider, not Claude's vision or placement. For every
 * fixture with B-roll, each asset has a line it obviously belongs to (from its file
 * name and the spoken words; `expect.broll` in the acceptance specs, EXPECTED below for
 * the Phase 0 fixtures), or none when nothing makes it obvious. Measured:
 *
 * - on its line: the asset is placed and its overlay starts while that line plays;
 * - rules, for every B-roll overlay: never starts in the first HOOK_PROTECT_SEC
 *   seconds, never overlaps another overlay (B-roll or graphic), never runs past the
 *   end of the video, and a video asset never runs past its own end.
 */

export const BROLL_SPECS = join(REPO, 'fixtures/specs/acceptance/broll');
const OUT = join(REPO, 'fixtures/acceptance/out');

/** Obvious lines for the B-roll of the Phase 0 fixtures; null when no line obviously fits. */
const EXPECTED: Record<string, Record<string, string | null>> = {
  routine: { 'broll/shelf.mp4': null, 'broll/stopwatch.jpg': 'ten seconds', 'broll/product.jpg': null },
  unboxing: { 'broll/desk_before.jpg': 'desk is a mess', 'broll/organizer.mp4': 'organizer showed up' },
};

export interface AssetResult {
  fixture: string;
  file: string;
  description: string;
  expectedLine: string | null;
  placedAt: Array<{ outStart: number; outEnd: number; text: string }>;
  onLine: boolean;
  /** Why it is where it is, or why it is not placed (`explainBroll`). */
  why: string;
  problems: string[];
}

export function ensureBrollFixtures(): void {
  execFileSync('node', [join(REPO, 'fixtures/acceptance/generate.mjs'), '--specs', BROLL_SPECS, '--out', OUT], { stdio: ['ignore', 'pipe', 'inherit'] });
}

export async function runBrollProxy(): Promise<AssetResult[]> {
  ensureBrollFixtures();
  const dirs = [
    ...findFixtures().filter((d) => d.split('/').pop()! in EXPECTED),
    ...findFixtures([OUT]).filter((d) => d.split('/').pop()!.startsWith('br-')),
  ];
  const out: AssetResult[] = [];
  for (const dir of dirs) {
    const id = dir.split('/').pop()!;
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      broll: Array<{ file: string }>;
      expect?: { broll?: Record<string, string> };
    };
    const expected: Record<string, string | null> =
      EXPECTED[id] ?? Object.fromEntries(Object.entries(manifest.expect?.broll ?? {}).map(([f, l]) => [`broll/${f}`, l]));
    const score = await scoreFixture(dir);
    const edl = score.edl;
    const tl = resolveTimeline(edl);
    const segText = (segId: string) => edl.segments.find((s) => s.id === segId)?.text ?? '';
    const placed = tl.overlays;
    const lines = buildLines(edl, score.input.transcripts);
    const why = explainBroll({ assets: score.broll.map((b) => b.asset), lines, overlays: edl.overlays, brollOn: edl.settings.broll, totalSec: tl.durationSec });
    manifest.broll.forEach((b, i) => {
      const asset = score.broll[i]!.asset;
      const want = expected[b.file] ?? null;
      const mine = placed.filter((o) => o.overlay.type === 'broll' && (o.overlay as BrollOverlay).assetId === asset.id);
      const problems: string[] = [];
      for (const o of mine) {
        const ov = o.overlay as BrollOverlay;
        if (o.outStart < HOOK_PROTECT_SEC - 1e-3) problems.push(`starts at ${o.outStart.toFixed(2)} s, inside the first ${HOOK_PROTECT_SEC} s`);
        const raw = o.outStart + ov.durationSec;
        if (raw > tl.durationSec + 1e-3) problems.push(`runs to ${raw.toFixed(2)} s, past the end at ${tl.durationSec.toFixed(2)} s`);
        if (asset.kind === 'video' && ov.sourceStartSec + ov.durationSec > (asset.durationSec ?? 0) + 1e-3) problems.push('runs past the end of its clip');
        for (const other of placed) {
          if (other === o) continue;
          if (o.outStart < other.outEnd - 1e-3 && other.outStart < o.outEnd - 1e-3) problems.push(`overlaps ${other.overlay.type} ${other.overlay.id}`);
        }
      }
      let onLine = false;
      if (want) {
        const lineItems = tl.items.filter((it) => it.segment.text.toLowerCase().includes(want.toLowerCase()));
        if (!lineItems.length) problems.push(`its line "${want}" is not in the cut`);
        onLine = mine.some((o) => lineItems.some((it) => o.outStart >= it.outStart - 1e-3 && o.outStart < it.outEnd - 1e-3));
      }
      out.push({
        fixture: id,
        file: b.file,
        description: asset.description,
        expectedLine: want,
        placedAt: mine.map((o) => ({ outStart: o.outStart, outEnd: o.outEnd, text: segText(o.overlay.anchorSegmentId) })),
        onLine,
        why: why.find((w) => w.assetId === asset.id)?.reason ?? '',
        problems,
      });
    });
  }
  return out;
}

export function formatBroll(rs: AssetResult[]): string {
  const lines: string[] = [];
  for (const r of rs) {
    const where = r.placedAt.length ? r.placedAt.map((p) => `${p.outStart.toFixed(2)}-${p.outEnd.toFixed(2)} s over "${p.text}"`).join('; ') : 'not placed';
    const verdict = r.expectedLine === null ? 'no obvious line' : r.onLine ? 'ON ITS LINE' : 'MISSED';
    lines.push(`${r.fixture} ${r.file} ("${r.description}"): expected ${r.expectedLine ? `"${r.expectedLine}"` : 'none'}; ${where} -> ${verdict}`);
    lines.push(`    why: ${r.why}`);
    for (const p of r.problems) lines.push(`    RULE: ${p}`);
  }
  const withLine = rs.filter((r) => r.expectedLine !== null);
  const hit = withLine.filter((r) => r.onLine).length;
  const placements = rs.reduce((n, r) => n + r.placedAt.length, 0);
  const broken = rs.filter((r) => r.problems.some((p) => !p.startsWith('its line'))).length;
  const wrong = withLine.filter((r) => r.placedAt.length && !r.onLine).length;
  const unplaced = withLine.filter((r) => !r.placedAt.length).length;
  lines.push(
    '',
    `Assets with an obvious line: ${withLine.length}; placed on that line: ${hit} (${withLine.length ? ((100 * hit) / withLine.length).toFixed(0) : 'n/a'}%).`,
    `Placed on a different line: ${wrong}; not placed at all: ${unplaced} (each with its reason above).`,
    `B-roll placements: ${placements}; assets whose placement breaks a rule (hook, overlap, past the end): ${broken}.`,
    'This is a proxy with the offline describer (file names) and the heuristic decider, not Claude: it says nothing about whether a creator would accept Claude\'s placements.',
  );
  return lines.join('\n');
}

export function brollFixturesExist(): boolean {
  return existsSync(BROLL_SPECS);
}
