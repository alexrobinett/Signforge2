// The target picker's query in the store (#180): one open picker at a time, its search empty on
// each open.
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createTargetPickerSlice, type TargetPickerSlice } from '../src/state/target-picker';

describe('the target picker', () => {
  it('keeps one query for the open picker, empty each time one opens, and none once closed', () => {
    const store = createStore<TargetPickerSlice>()((set, get) => createTargetPickerSlice(set as never, get as never, {} as never));
    store.getState().openTargetPicker('picker-a');
    store.getState().searchTargets('drive');
    expect(store.getState().targetPicker).toEqual({ open: 'picker-a', query: 'drive' });
    store.getState().openTargetPicker('picker-b');
    expect(store.getState().targetPicker).toEqual({ open: 'picker-b', query: '' });
    store.getState().closeTargetPicker();
    expect(store.getState().targetPicker).toEqual({ open: null, query: '' });
  });
});
