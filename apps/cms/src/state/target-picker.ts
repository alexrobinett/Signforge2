/**
 * The target picker (components/schedule/target-picker.tsx): which one is open, and what is typed
 * in its search. One is open at a time, so one query serves them all.
 */
import type { SliceCreator } from './store';

interface TargetPickerState {
  /** The open picker's id (React's `useId`), or null. */
  open: string | null;
  query: string;
}

export interface TargetPickerSlice {
  targetPicker: TargetPickerState;
  /** Opens a picker with an empty search. */
  openTargetPicker: (id: string) => void;
  searchTargets: (query: string) => void;
  closeTargetPicker: () => void;
}

const CLOSED: TargetPickerState = { open: null, query: '' };

export const createTargetPickerSlice: SliceCreator<TargetPickerSlice> = (set) => ({
  targetPicker: CLOSED,
  openTargetPicker: (id) => set({ targetPicker: { open: id, query: '' } }),
  searchTargets: (query) => set((s) => ({ targetPicker: { ...s.targetPicker, query } })),
  closeTargetPicker: () => set({ targetPicker: CLOSED }),
});
