import { memo, useCallback, useImperativeHandle, useMemo, useRef } from 'react';
import { View } from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { TranscriptRowView } from './TranscriptRowView';
import type { RowModel } from './rowModels';
import { ACTIVE_ROW_OFFSET, ROW_GAP, type TranscriptListProps } from './TranscriptList.types';

export type { TranscriptListHandle, TranscriptListProps } from './TranscriptList.types';

const keyOf = (m: RowModel) => m.row.segmentId;
// Rows of one kind recycle into each other (a cut row has the reason line under it).
const typeOf = (m: RowModel) => (m.row.isSilence ? 'pause' : m.row.keep ? 'kept' : 'cut');
const Gap = () => <View style={{ height: ROW_GAP }} />;

/**
 * iOS and Android: the transcript as a FlashList (v2: measured, recycled cells), so a video of
 * 4000 lines scrolls at the display's frame rate. Rows are memoised on stable models and
 * handlers; only the playing row, the row just toggled and the row the stepper landed on
 * receive changed props. Web is `TranscriptList.web.tsx`.
 */
export const TranscriptList = memo(function TranscriptList({ models, activeId, pulse, flash, actions, bottomPadding, onTouchState, ref }: TranscriptListProps) {
  const list = useRef<FlashListRef<RowModel>>(null);
  const index = useMemo(() => new Map(models.map((m, i) => [m.row.segmentId, i])), [models]);
  const indexRef = useRef(index);
  indexRef.current = index;

  useImperativeHandle(
    ref,
    () => ({
      scrollToRow(segmentId) {
        const i = indexRef.current.get(segmentId);
        const l = list.current;
        if (i === undefined || !l) return;
        const y = l.getLayout(i)?.y;
        if (y !== undefined && y < ACTIVE_ROW_OFFSET) l.scrollToOffset({ offset: 0, animated: true });
        else void l.scrollToIndex({ index: i, animated: true, viewOffset: -ACTIVE_ROW_OFFSET });
      },
    }),
    [],
  );

  const extra = useMemo(() => ({ activeId, pulse, flash }), [activeId, pulse, flash]);
  const renderItem = useCallback(
    ({ item, extraData }: { item: RowModel; extraData?: typeof extra }) => {
      const id = item.row.segmentId;
      return (
        <TranscriptRowView
          model={item}
          active={extraData?.activeId === id}
          pulse={extraData?.pulse?.id === id ? extraData.pulse.n : 0}
          flash={extraData?.flash?.id === id ? extraData.flash.n : 0}
          actions={actions}
        />
      );
    },
    [actions],
  );

  return (
    <FlashList
      ref={list}
      data={models}
      extraData={extra}
      renderItem={renderItem}
      keyExtractor={keyOf}
      getItemType={typeOf}
      ItemSeparatorComponent={Gap}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: bottomPadding }}
      // Only the creator's own scrolling pauses auto-scroll (a programmatic scroll ends without a drag).
      onScrollBeginDrag={() => onTouchState(true)}
      onScrollEndDrag={() => onTouchState(false)}
      onMomentumScrollBegin={() => onTouchState(true)}
      onMomentumScrollEnd={() => onTouchState(false)}
      showsVerticalScrollIndicator
      testID="transcript"
    />
  );
});
