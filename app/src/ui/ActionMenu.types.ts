import type { SFSymbol } from 'sf-symbols-typescript';
import type { IconName } from './Icon';

/** One item of a menu: native menus on iOS, Kilo's popover elsewhere, header menus too. */
export interface MenuItem {
  label: string;
  /** One line under the label ("Kilo cuts them for you"). */
  subtitle?: string;
  icon?: IconName;
  /** An SF Symbol for iOS when the Kilo icon set has no match (e.g. `photo.on.rectangle.angled`). */
  sf?: SFSymbol;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
  testID?: string;
}

export interface ActionMenuProps {
  /** The trigger's icon (a 44pt glass circle). */
  icon: IconName;
  /** The trigger's spoken name ("New"). */
  label: string;
  items: MenuItem[];
  /** A title over the items (optional). */
  title?: string;
  testID?: string;
}
