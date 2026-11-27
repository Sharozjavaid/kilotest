import { View } from 'react-native';
import { IconButton, Text, makeStyles, size } from '@/ui';

const useStyles = makeStyles(() => ({
  row: { flexDirection: 'row', alignItems: 'center', height: size.touch },
  side: { width: size.touch, alignItems: 'center' },
  title: { flex: 1, fontSize: 17 },
}));

/**
 * The title row of a form sheet (design brief 5.9): the title centred (Inter 600 17) and a glass
 * `xmark` on the trailing side. For sheets that draw their own header (a form sheet's content
 * sits on the system's glass, with no navigation bar).
 */
export function SheetHeader({ title, onClose, closeLabel = 'Close' }: { title: string; onClose: () => void; closeLabel?: string }) {
  const s = useStyles();
  return (
    <View style={s.row}>
      <View style={s.side} />
      <Text variant="body" weight={600} center numberOfLines={1} style={s.title} accessibilityRole="header">
        {title}
      </Text>
      <View style={s.side}>
        <IconButton icon="close" label={closeLabel} onPress={onClose} />
      </View>
    </View>
  );
}
