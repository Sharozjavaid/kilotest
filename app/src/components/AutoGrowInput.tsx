import { useState } from 'react';
import { TextInput, type TextInputProps } from 'react-native';

/** A multiline TextInput that grows with its text (web does not grow multiline inputs by itself). */
export function AutoGrowInput({ minHeight = 44, style, onContentSizeChange, ...props }: TextInputProps & { minHeight?: number }) {
  const [height, setHeight] = useState(minHeight);
  return (
    <TextInput
      {...props}
      multiline
      scrollEnabled={false}
      onContentSizeChange={(e) => {
        setHeight(Math.max(minHeight, Math.ceil(e.nativeEvent.contentSize.height)));
        onContentSizeChange?.(e);
      }}
      style={[style, { height }]}
    />
  );
}
