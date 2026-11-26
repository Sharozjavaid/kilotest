import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Card, Header, Icon, Screen, Text, color, type IconName } from '@/ui';

/**
 * Stand-in for a screen the next mobile engineer builds (recorder, B-roll, styles,
 * goal). Says plainly that it is not built yet.
 */
export function Placeholder({
  title,
  icon,
  body,
  tab,
  children,
}: {
  title: string;
  icon: IconName;
  body: string;
  /** Root tab screens have no back button. */
  tab?: boolean;
  children?: ReactNode;
}) {
  return (
    <Screen bottomInset={!tab}>
      <Header title={title} noBack={tab} />
      <Card gap={10} padding={24} style={{ alignItems: 'center' }}>
        <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: color.skyTint, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={icon} size={24} color={color.accent} />
        </View>
        <Text variant="bodyLg" center>
          Coming soon
        </Text>
        <Text variant="secondary" tone="muted" center>
          {body}
        </Text>
      </Card>
      {children}
    </Screen>
  );
}
