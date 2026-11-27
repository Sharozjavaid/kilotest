import { setPendingPicks, takePendingPicks } from './handoff';
import type { PickedFile } from './grouping';

const file = (id: string): PickedFile => ({ id, uri: `file:///${id}.mov`, filename: `${id}.mov`, contentType: 'video/quicktime', sizeBytes: 10, kind: 'video' });

describe('pending picks', () => {
  it('hands the picks to the sheet once', () => {
    setPendingPicks([file('a'), file('b')]);
    expect(takePendingPicks().map((f) => f.id)).toEqual(['a', 'b']);
    expect(takePendingPicks()).toEqual([]);
  });

  it('keeps its own copy of the list', () => {
    const list = [file('a')];
    setPendingPicks(list);
    list.push(file('b'));
    expect(takePendingPicks()).toHaveLength(1);
  });
});
