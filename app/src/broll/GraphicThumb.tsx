import { View } from 'react-native';
import { getGraphicTheme, type TemplateId } from '@kilo/edl';
import { color, radius } from '@/ui/tokens';
import { Text } from '@/ui/type';

/** The words a template shows, for a thumbnail. */
export function graphicHeadline(template: TemplateId, props: Record<string, unknown>): string {
  const str = (k: string) => (typeof props[k] === 'string' ? (props[k] as string) : '');
  const list = (k: string) => (Array.isArray(props[k]) ? (props[k] as unknown[]).map(String) : []);
  switch (template) {
    case 'bold-title':
      return str('text');
    case 'numbered-list':
      return str('title') || list('items')[0] || '';
    case 'stat-callout':
      return str('value');
    case 'keyword-pop':
      return list('words').join(' ');
    case 'price-tag':
      return str('price');
  }
}

/** A 54 x 72 card in the video's graphic theme with the template's words (mock-up `Broll`). */
export function GraphicThumb({ template, props, themeId, width = 54, height = 72 }: { template: TemplateId; props: Record<string, unknown>; themeId: string; width?: number; height?: number }) {
  const theme = getGraphicTheme(themeId);
  const small = width < 50;
  // Whole words only: a small thumb shows the first two, a card thumb up to four.
  const all = graphicHeadline(template, props).toUpperCase().split(/\s+/).filter(Boolean);
  const words = all.slice(0, small ? 2 : 4).join(' ');
  const fontSize = small ? 7.5 : 10;
  return (
    <View
      style={{
        width,
        height,
        borderRadius: radius.sm + 2,
        backgroundColor: theme.background,
        borderWidth: theme.background.toUpperCase() === '#FFFFFF' ? 1 : 0,
        borderColor: color.hairline,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 2,
        flexShrink: 0,
        overflow: 'hidden',
      }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text variant="label" weight={700} numberOfLines={small ? 3 : 4} center style={{ color: theme.foreground, fontSize, lineHeight: fontSize * 1.15, letterSpacing: -0.2 }}>
        {words}
      </Text>
      {template === 'price-tag' || template === 'stat-callout' ? <View style={{ width: 18, height: 3, borderRadius: 2, marginTop: 4, backgroundColor: theme.accent }} /> : null}
    </View>
  );
}
