import { memo, useState } from 'react';
import type { Captions } from '@kilo/edl';
import { captionsLabel } from './captions';
import { Chip } from '@/ui/Chip';
import { CaptionsSheet } from './CaptionsSheet';

export { CAPTION_STYLES, captionsLabel, captionHint, type CaptionsSheetProps } from './captions';

/**
 * The captions chip in Review's tools row (design brief 4.6): "Captions off" / "Captions: Bold".
 * It opens a sheet with the burn-in switch and the three styles: a native form sheet at the
 * medium detent on iOS (SwiftUI `Form`), Kilo's bottom sheet elsewhere. Edits `edl.captions`.
 */
export const CaptionsControl = memo(function CaptionsControl({ captions, onChange }: { captions: Captions; onChange: (c: Captions) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Chip
        label={captionsLabel(captions)}
        selected={captions.enabled}
        onPress={() => setOpen(true)}
        accessibilityLabel={`${captionsLabel(captions)}. Change captions`}
        testID="captions-chip"
      />
      <CaptionsSheet open={open} captions={captions} onChange={onChange} onClose={() => setOpen(false)} />
    </>
  );
});
