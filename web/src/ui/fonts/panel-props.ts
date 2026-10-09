// Props of the lazily loaded picker body (FontPickerPanel.svelte), shared with its trigger
// (FontPicker.svelte) without importing the component itself (that would defeat the lazy chunk).
import type { TextItem } from '../../doc/schema'
import type { FontPatch } from './font-choice'

export interface PanelProps {
  item: TextItem
  /** The trigger: the desktop popover opens under (or above) it. */
  anchor: HTMLElement | undefined
  /** A font was chosen (the panel has already recorded it as recent). */
  onpick: (patch: FontPatch) => void
  /** Closed (pick, Escape, backdrop, close button): the trigger takes the focus back. */
  onclose: () => void
}
