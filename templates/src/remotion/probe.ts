/**
 * Layout probe, for the acceptance sweep only (scripts/sweep.ts). When a graphic is
 * rendered with `probe: true` in its input props, the page measures what it drew and
 * prints one `KILO_PROBE <json>` console line, which the sweep reads through
 * Remotion's browser log. Nothing here changes what is drawn.
 *
 * Every text node is measured with the page's own font metrics: its ink box (canvas
 * `actualBoundingBox*` of the exact string, font and letter-spacing, scaled by the
 * element's effective scale), the size it is drawn at in output pixels, the nearest
 * ancestor that paints a box (its container) and every ancestor that clips. Boxes that
 * paint something (cards, chips, badges, bars) are listed too. Characters are checked
 * for the missing-glyph box: each is drawn with the element's font stack on a canvas
 * and compared with an unassigned code point, which can only draw as `.notdef`.
 */

export interface ProbeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ProbeText {
  id: number;
  text: string;
  /** Font size as drawn, in output pixels. */
  sizePx: number;
  ink: ProbeRect;
  /** The nearest ancestor that paints a box, or null (text straight on the footage or plate). */
  container: number | null;
  /** Ancestors that clip (overflow other than visible). */
  clips: number[];
  /** Characters that draw as the missing-glyph box. */
  tofu: string[];
  /** Every box among its ancestors. */
  ancestors: number[];
  /** Ink box of each grapheme cluster, for overlap tests finer than the whole text. */
  glyphs: ProbeRect[];
  fontFamily: string;
}

export interface ProbeBox {
  id: number;
  rect: ProbeRect;
  /** Covers the whole frame: a full-screen plate. */
  plate: boolean;
  /** Marked `data-probe="decoration"`: drawn over its own text on purpose (a strike line). */
  decoration: boolean;
  /** Paints a background (as opposed to only clipping). */
  paints: boolean;
  /** The nearest box among its ancestors, or null. */
  parent: number | null;
}

export interface ProbeResult {
  width: number;
  height: number;
  texts: ProbeText[];
  boxes: ProbeBox[];
}

const rectOf = (r: DOMRect): ProbeRect => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });

function paints(cs: CSSStyleDeclaration): boolean {
  const bg = cs.backgroundColor;
  const m = /rgba?\(([^)]+)\)/.exec(bg);
  const alphaOk = m ? (m[1]!.split(',').map((x) => x.trim())[3] ?? '1') !== '0' : bg !== 'transparent';
  return (alphaOk && bg !== 'transparent') || (cs.backgroundImage !== 'none' && cs.backgroundImage !== '');
}

let canvas: HTMLCanvasElement | null = null;
function ctx2d(): CanvasRenderingContext2D {
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 96;
  }
  return canvas.getContext('2d', { willReadFrequently: true })!;
}

function glyphHash(ch: string, family: string, weight: string): string {
  const c = ctx2d();
  c.clearRect(0, 0, 96, 96);
  c.font = `${weight} 64px ${family}`;
  c.fillStyle = '#000';
  c.textBaseline = 'middle';
  c.fillText(ch, 8, 48);
  const d = c.getImageData(0, 0, 96, 96).data;
  let h = 0;
  for (let i = 3; i < d.length; i += 4) h = (h * 31 + d[i]!) >>> 0;
  return `${h}:${Math.round(c.measureText(ch).width)}`;
}

/** U+0378 is unassigned: no font has it, so it draws as the missing-glyph box. */
const MISSING = '͸';

export function probeLayout(root: HTMLElement, width: number, height: number): ProbeResult {
  const boxes: ProbeBox[] = [];
  const boxId = new Map<Element, number>();
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const cs = getComputedStyle(el);
    const clipsHere = cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
    const p = paints(cs) && Number(cs.opacity) > 0;
    if (!p && !clipsHere) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const id = boxes.length;
    boxId.set(el, id);
    boxes.push({
      id,
      rect: rectOf(r),
      plate: r.width >= width * 0.98 && r.height >= height * 0.98,
      decoration: (el as HTMLElement).dataset?.probe === 'decoration',
      paints: p,
      parent: null,
    });
  }
  for (const [el, id] of boxId) {
    for (let a = el.parentElement; a && a !== root.parentElement; a = a.parentElement) {
      const pid = boxId.get(a);
      if (pid !== undefined) {
        boxes[id]!.parent = pid;
        break;
      }
    }
  }

  const texts: ProbeText[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const c = ctx2d();
  const missingByFont = new Map<string, string>();
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const raw = node.data;
    if (!raw.trim()) continue;
    const el = node.parentElement!;
    const cs = getComputedStyle(el);
    if (Number(cs.opacity) === 0) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (r.width <= 0) continue;
    const shown = cs.textTransform === 'uppercase' ? raw.toUpperCase() : raw;
    const fs = parseFloat(cs.fontSize);
    c.font = `${cs.fontWeight} ${fs}px ${cs.fontFamily}`;
    (c as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
    const m = c.measureText(shown);
    // Effective scale of the element (the design-to-output scale times any transform).
    const k = m.width > 0 ? r.width / m.width : 1;
    const baseline = r.top + m.fontBoundingBoxAscent * k;
    const ink: ProbeRect = {
      left: r.left - m.actualBoundingBoxLeft * k,
      right: r.left + m.actualBoundingBoxRight * k,
      top: baseline - m.actualBoundingBoxAscent * k,
      bottom: baseline + m.actualBoundingBoxDescent * k,
    };
    // Per grapheme cluster: horizontal extent from the DOM, vertical ink from the font.
    const glyphs: ProbeRect[] = [];
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const g of seg.segment(raw)) {
      if (!g.segment.trim()) continue;
      const gr = document.createRange();
      gr.setStart(node, g.index);
      gr.setEnd(node, g.index + g.segment.length);
      const rr = gr.getBoundingClientRect();
      if (rr.width <= 0) continue;
      const gm = c.measureText(cs.textTransform === 'uppercase' ? g.segment.toUpperCase() : g.segment);
      glyphs.push({ left: rr.left, right: rr.right, top: baseline - gm.actualBoundingBoxAscent * k, bottom: baseline + gm.actualBoundingBoxDescent * k });
    }
    let container: number | null = null;
    const clips: number[] = [];
    const ancestors: number[] = [];
    for (let a: Element | null = el; a && a !== root.parentElement; a = a.parentElement) {
      const id = boxId.get(a);
      if (id === undefined) continue;
      ancestors.push(id);
      const b = boxes[id]!;
      if (b.paints && !b.plate && container === null) container = id;
      const acs = getComputedStyle(a);
      if (acs.overflow !== 'visible' || acs.overflowX !== 'visible' || acs.overflowY !== 'visible') clips.push(id);
    }
    const fontKey = `${cs.fontWeight}|${cs.fontFamily}`;
    if (!missingByFont.has(fontKey)) missingByFont.set(fontKey, glyphHash(MISSING, cs.fontFamily, cs.fontWeight));
    const missing = missingByFont.get(fontKey)!;
    const tofu: string[] = [];
    for (const ch of new Set(Array.from(shown.replace(/\s+/g, '')))) {
      if (glyphHash(ch, cs.fontFamily, cs.fontWeight) === missing) tofu.push(ch);
    }
    texts.push({ id: texts.length, text: shown, sizePx: fs * k, ink, container, clips, tofu, ancestors, glyphs, fontFamily: cs.fontFamily });
  }
  return { width, height, texts, boxes };
}
