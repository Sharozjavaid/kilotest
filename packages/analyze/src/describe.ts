import { basename, extname } from 'node:path';
import type { BrollDescriber } from './ingest.js';
import { capitalize } from './text.js';

const CAMERA_TOKENS = new Set(['img', 'dsc', 'dscn', 'vid', 'pxl', 'mov', 'mvi', 'gopr', 'dji', 'screenshot', 'copy', 'final', 'edit', 'export', 'stock', 'pexels', 'source', 'normalized']);

/**
 * Readable words from a file name: "desk_before-2.jpg" gives "desk before". The name
 * is the uploader's: only letters, digits and apostrophes inside words survive, so no
 * markup, format directive, quote or line break reaches a description.
 */
export function wordsFromFilename(filename: string | undefined): string {
  if (!filename) return '';
  const stemName = basename(filename, extname(filename)).slice(0, 200);
  return stemName
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, '').toLowerCase())
    .filter((w) => w && !/^\d+$/.test(w) && !CAMERA_TOKENS.has(w) && !/^[0-9a-f]{8,}$/.test(w))
    .join(' ');
}

function orientation(w?: number, h?: number): string {
  if (!w || !h) return '';
  if (Math.abs(w - h) / Math.max(w, h) < 0.05) return 'square';
  return w > h ? 'landscape' : 'portrait';
}

/** The offline describer: file name plus probe data, as one readable line. */
export const filenameDescriber: BrollDescriber = async (input) => {
  const subject = wordsFromFilename(input.filename);
  const shape = orientation(input.sourceWidth ?? input.width, input.sourceHeight ?? input.height);
  const what =
    input.kind === 'image'
      ? `Still image${shape ? `, ${shape}` : ''}`
      : `Video clip, ${(input.durationSec ?? 0).toFixed(1)} s${shape ? `, ${shape}` : ''}`;
  return subject ? `${capitalize(subject)} (${what.charAt(0).toLowerCase()}${what.slice(1)})` : what;
};
