import type { Style } from '@kilo/edl';

export interface StyleMenuProps {
  styles: readonly Pick<Style, 'id' | 'name' | 'isDefault'>[];
  /** The style the settings match, or null for settings of their own ("Custom"). */
  currentId: string | null;
  onPick: (id: string) => void;
}
