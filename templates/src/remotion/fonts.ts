import { staticFile } from 'remotion';
import { FALLBACK_FONTS } from './scripts';
import { BUNDLED_DISPLAY, BUNDLED_TEXT } from './style';

const FACES: Array<[family: string, file: string, weight: number]> = [
  [BUNDLED_TEXT, 'Inter-SemiBold.otf', 600],
  [BUNDLED_TEXT, 'Inter-Bold.otf', 700],
  [BUNDLED_TEXT, 'Inter-ExtraBold.otf', 800],
  [BUNDLED_DISPLAY, 'InterDisplay-Bold.otf', 700],
  [BUNDLED_DISPLAY, 'InterDisplay-ExtraBold.otf', 800],
  [BUNDLED_DISPLAY, 'InterDisplay-Black.otf', 900],
];

let loading: Promise<void> | null = null;

/** Loads the bundled Inter faces into the page once. */
export function loadFonts(): Promise<void> {
  if (!loading) {
    loading = Promise.all(
      FACES.map(async ([family, file, weight]) => {
        const face = new FontFace(family, `url(${staticFile(`fonts/${file}`)})`, { weight: String(weight), style: 'normal' });
        await face.load();
        (document.fonts as unknown as { add(f: FontFace): void }).add(face);
      }),
    ).then(() => undefined);
  }
  return loading;
}

/**
 * Loads the bundled fallback faces (fallback-fonts.css) that `text` needs: each family is
 * split into subsets by unicode-range, and only the subsets holding a character of the
 * text are fetched. Resolves once they are in, so text is never measured with a face
 * that has not arrived.
 */
export async function loadFallbackFonts(text: string): Promise<void> {
  const sample = `${text}${text.toUpperCase()}`.replace(/\s+/g, '');
  if (!sample) return;
  const fontSet = document.fonts as unknown as { load(font: string, text?: string): Promise<unknown[]> };
  await Promise.all(FALLBACK_FONTS.flatMap((f) => ['400', '700', '800', '900'].map((w) => fontSet.load(`${w} 100px "${f.family}"`, sample))));
}
