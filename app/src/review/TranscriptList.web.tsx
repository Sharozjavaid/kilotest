import { memo, useImperativeHandle, useRef } from 'react';
import { ScrollView, View, type ScrollViewInstance } from 'react-native';
import { TranscriptRowView } from './TranscriptRowView';
import { ACTIVE_ROW_OFFSET, ROW_GAP, type TranscriptListProps } from './TranscriptList.types';

export type { TranscriptListHandle, TranscriptListProps } from './TranscriptList.types';

/**
 * Web: every row in a plain ScrollView, as before (the browser end-to-end suite reads every
 * row of a video, which a virtualised list would not have in the page). Same props as the
 * native FlashList.
 */
export const TranscriptList = memo(function TranscriptList({ models, activeId, pulse, flash, actions, bottomPadding, onTouchState, ref }: TranscriptListProps) {
  const scroll = useRef<ScrollViewInstance>(null);
  const rowY = useRef(new Map<string, number>());
  useImperativeHandle(
    ref,
    () => ({
      scrollToRow(segmentId) {
        const y = rowY.current.get(segmentId);
        if (y !== undefined) scroll.current?.scrollTo({ y: Math.max(0, y - ACTIVE_ROW_OFFSET), animated: true });
      },
    }),
    [],
  );
  return (
    <ScrollView
      ref={scroll}
      style={{ flex: 1, minHeight: 0 }}
      contentContainerStyle={{ gap: ROW_GAP, paddingHorizontal: 20, paddingTop: 4, paddingBottom: bottomPadding }}
      // Only the creator's own scrolling pauses auto-scroll (a programmatic scroll ends without a drag).
      onScrollBeginDrag={() => onTouchState(true)}
      onScrollEndDrag={() => onTouchState(false)}
      onMomentumScrollBegin={() => onTouchState(true)}
      onMomentumScrollEnd={() => onTouchState(false)}
      testID="transcript"
    >
      {models.map((m) => {
        const id = m.row.segmentId;
        return (
          <View key={id} onLayout={(e) => rowY.current.set(id, e.nativeEvent.layout.y)}>
            <TranscriptRowView model={m} active={id === activeId} pulse={pulse?.id === id ? pulse.n : 0} flash={flash?.id === id ? flash.n : 0} actions={actions} />
          </View>
        );
      })}
    </ScrollView>
  );
});
