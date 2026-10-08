<!-- W4 — properties of a spacer block (blank space along the label). -->
<script lang="ts">
  import type { SpacerItem } from '../../../doc/schema'
  import NumberField from '../../common/NumberField.svelte'
  import { getStudio } from '../../state/studio.svelte'

  let { item }: { item: SpacerItem } = $props()
  const studio = getStudio()
</script>

<NumberField
  label="Width"
  unit="mm"
  min={0}
  max={500}
  step={0.5}
  value={item.widthMm}
  hint="Blank space between the blocks on either side."
  onchange={(widthMm) => studio.updateItem<SpacerItem>(item.id, { widthMm }, `${item.id}:width`)}
/>
