<!-- Tables (docs/TABLE-PLAN.md §4, §12) — properties of a table block (lazy chunk, with
     TableCells, TableGrid and doc/table.ts): its size and a link to the "Table cells" card under
     the preview (where the cells are edited), text direction, one font, weight and size for every
     cell, column width / piece length, alignment, padding, grid lines, cut marks and "cut between
     columns" (hidden on printers without a cutter). Edits go through Studio.updateItem; every
     change is one undo step. -->
<script lang="ts">
  import { LIMITS, type FontWeight, type LabelDoc, type TableColumns, type TableDirection, type TableItem, type TextItem } from '../../../doc/schema'
  import { updateDoc, updateItem } from '../../../doc/ops'
  import { colCount } from '../../../doc/table'
  import { dotsToMm, fontDef, pageLengthsMm } from '../../../render'
  import { emDotsToPt } from '../../../render/text-size'
  import { customFontMissing } from '../../../render/fonts'
  import FontPicker from '../../fonts/FontPicker.svelte'
  import Icon from '../../common/Icon.svelte'
  import NumberField from '../../common/NumberField.svelte'
  import Segmented from '../../common/Segmented.svelte'
  import Slider from '../../common/Slider.svelte'
  import Switch from '../../common/Switch.svelte'
  import { getStudio } from '../../state/studio.svelte'
  import { formatMm, piecesText } from '../../state/view-model'

  let { item }: { item: TableItem } = $props()
  const studio = getStudio()
  const id = $props.id()
  const set = (patch: Partial<Omit<TableItem, 'id' | 'kind'>>, key?: string) => studio.updateItem<TableItem>(item.id, patch, key ? `${item.id}:${key}` : undefined)

  const WEIGHT_NAMES: Record<FontWeight, string> = { 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold' }
  const weights = $derived(fontDef(item.fontFamily).weights)
  const across = $derived(item.direction !== 'along')
  const rows = $derived(item.cells.length)
  const cols = $derived(colCount(item.cells))

  /** The font picker works on a text block: this table seen as one (its id, so the render's
   * size and quality hints for the table apply; its first row as the preview text). */
  const fontView = $derived<TextItem>({
    id: item.id,
    kind: 'text',
    text: item.cells[0]?.filter((c) => c.trim()).join(' ') ?? '',
    fontFamily: item.fontFamily,
    ...(item.customFont ? { customFont: item.customFont } : {}),
    fontWeight: item.fontWeight,
    italic: item.italic,
    size: item.size,
    align: item.align,
    lineHeight: 1,
    invert: false,
  })
  const customMissing = $derived.by(() => {
    void studio.render
    return !!item.customFont && customFontMissing(item.customFont)
  })

  /** The cells are edited in the "Table cells" card under the preview: focus its current cell. */
  function editCells(): void {
    const card = document.getElementById('table-cells')
    const cell = card?.querySelector<HTMLInputElement>('input[data-cur]') ?? card?.querySelector<HTMLInputElement>('input')
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    cell?.focus({ preventScroll: true })
  }

  const DIRECTION_HINTS: Record<TableDirection, string> = {
    along: 'Rows run along the tape, one column after the other.',
    'across-down': 'Each column is a piece; its text reads from the top tape edge down. Hold a piece with its left end toward you to read it left to right.',
    'across-up': 'Each column is a piece; its text reads from the bottom tape edge up. Hold a piece with its right end toward you to read it left to right.',
  }

  // Column width / piece length: switching to Fixed starts from today's measured width.
  const box = $derived(studio.render?.boxes.find((b) => b.itemId === item.id))
  const dpi = $derived(studio.target.ok ? studio.target.target.area.dpi : 180)
  function setColumnsMode(mode: TableColumns['mode']): void {
    if (mode !== 'mm') return set({ columns: { mode } })
    const measured = box && cols ? dotsToMm(box.w / cols, dpi) : 20
    set({ columns: { mode: 'mm', mm: Math.min(LIMITS.tableColumnMm.max, Math.max(LIMITS.tableColumnMm.min, Math.round(measured * 2) / 2)) } })
  }
  /** Points that keep today's size (Fit → Points), from the render. */
  function currentPt(): number {
    const em = studio.render?.texts?.find((t) => t.itemId === item.id)?.emDots
    return em ? emDotsToPt(em, dpi) : 12
  }
  const columnsMode = $derived(across && item.columns.mode === 'equal' ? 'auto' : item.columns.mode)

  // Cutting: needs a cutter and Cut each; turning it on turns Cut each on (one undo step) and,
  // when the table is the only block that prints, sets the label margins to 0 so every piece is
  // the same length.
  const cutter = $derived(studio.modelInfo?.caps.autoCut !== false)
  const cutting = $derived(item.cutBetween && studio.doc.print.autoCut && cutter)
  const pieces = $derived(cutting && studio.render?.cuts ? piecesText(pageLengthsMm(studio.render), studio.render.feedMarginMm) : null)
  function setCutBetween(on: boolean): void {
    const doc = studio.doc
    let next: LabelDoc = updateItem<TableItem>(doc, item.id, { cutBetween: on })
    const notes: string[] = []
    if (on && !doc.print.autoCut) {
      next = updateDoc(next, { print: { ...doc.print, autoCut: true } })
      notes.push('Cut each turned on')
    }
    const alone = doc.items.every((i) => i.id === item.id || i.kind === 'spacer' || i.kind === 'cut' || (i.kind === 'text' && i.text.trim() === ''))
    if (on && alone && (doc.marginsMm.start > 0 || doc.marginsMm.end > 0)) {
      next = updateDoc(next, { marginsMm: { start: 0, end: 0 } })
      notes.push('label margins set to 0 so every piece is the same length')
    }
    // The label frame is one box around the whole strip: the end pieces would be longer by its
    // space and the middle pieces open at both ends. The table's grid lines box every piece.
    if (on && alone && doc.frame) {
      next = updateDoc(next, { frame: undefined })
      notes.push(item.grid ? 'label frame turned off (the grid lines box every piece)' : 'label frame turned off; turn on Grid lines to box every piece')
    }
    studio.setDoc(next)
    studio.announce(on ? `The printer cuts between the columns${notes.length ? `. ${notes.join('; ')}` : ''}` : 'Cut between columns off')
    if (notes.length) studio.toast('info', 'Cut between columns', `${notes.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()))
  }
</script>

<p class="cells-link">
  <span>{rows} {rows === 1 ? 'row' : 'rows'} × {cols} {cols === 1 ? 'column' : 'columns'}</span> ·
  <button type="button" class="link" onclick={editCells}>edit the cells below the preview</button>
</p>

<Segmented
  label="Text direction"
  options={[
    { value: 'along', label: 'Along' },
    { value: 'across-down', label: 'Across ↓' },
    { value: 'across-up', label: 'Across ↑' },
  ]}
  value={item.direction}
  onchange={(direction) => set({ direction })}
/>
<p class="hint">{DIRECTION_HINTS[item.direction]}</p>

<div class="field-row">
  <div class="field">
    <label class="field-label" for="{id}-font">Font</label>
    <FontPicker item={fontView} id="{id}-font" describedby={customMissing ? `${id}-font-missing` : undefined} onchange={(patch) => set(patch)} />
  </div>
  <div class="field">
    {#if item.customFont && !customMissing}
      <span class="field-label">Weight</span>
      <p class="hint fixed">From the font file</p>
    {:else}
      <label class="field-label" for="{id}-weight">Weight</label>
      <select id="{id}-weight" class="select" value={String(item.fontWeight)} onchange={(e) => set({ fontWeight: Number(e.currentTarget.value) as FontWeight })}>
        {#each weights as w (w)}<option value={String(w)}>{WEIGHT_NAMES[w]}</option>{/each}
      </select>
    {/if}
  </div>
</div>
{#if item.customFont && customMissing}
  <div class="missing" id="{id}-font-missing" role="note">
    <Icon name="alert" size={16} />
    <p>“{item.customFont.family}” is not on this device — using {fontDef(item.fontFamily).label}.</p>
  </div>
{/if}

<Segmented
  label="Text size"
  options={[
    { value: 'fit', label: across ? 'Fit tape' : 'Fit rows' },
    { value: 'pt', label: 'Points' },
  ]}
  value={item.size.mode === 'pt' ? 'pt' : 'fit'}
  onchange={(mode) => set({ size: mode === 'pt' ? { mode: 'pt', pt: currentPt() } : { mode: 'fit' } }, 'size')}
/>
{#if item.size.mode === 'pt'}
  <NumberField label="Points" unit="pt" min={LIMITS.sizePt.min} max={LIMITS.sizePt.max} step={0.5} value={item.size.pt} hint="The same size in every cell; reduced when it does not fit." onchange={(pt) => set({ size: { mode: 'pt', pt } }, 'size')} />
{:else}
  <p class="hint">{across ? 'The longest cell fits across the tape; every cell gets its size.' : 'The text fills the rows; every cell gets the same size.'}</p>
{/if}

<Segmented
  label={across ? 'Piece length' : 'Column width'}
  options={across
    ? [
        { value: 'auto', label: 'Fit text' },
        { value: 'mm', label: 'Fixed' },
      ]
    : [
        { value: 'auto', label: 'Fit text' },
        { value: 'equal', label: 'Equal' },
        { value: 'mm', label: 'Fixed' },
      ]}
  value={columnsMode}
  onchange={setColumnsMode}
/>
{#if item.columns.mode === 'mm'}
  <NumberField
    label={across ? 'Length of each piece' : 'Width of each column'}
    unit="mm"
    min={LIMITS.tableColumnMm.min}
    max={LIMITS.tableColumnMm.max}
    step={0.5}
    value={item.columns.mm}
    hint={across ? 'Every piece is this long; the text gets smaller when it does not fit.' : 'Every column is this wide; the text gets smaller when a cell does not fit.'}
    onchange={(mm) => set({ columns: { mode: 'mm', mm } }, 'columns')}
  />
{:else if across}
  <p class="hint">Every piece is as long as its rows need, the same for every column.</p>
{/if}

<Segmented
  label="Align in cell"
  iconOnly
  options={[
    { value: 'start', label: across ? 'Align to the start' : 'Align left', icon: 'align-start' },
    { value: 'center', label: 'Align centre', icon: 'align-center' },
    { value: 'end', label: across ? 'Align to the end' : 'Align right', icon: 'align-end' },
  ]}
  value={item.align}
  onchange={(align) => set({ align })}
/>

<Slider label="Padding" min={LIMITS.tablePaddingMm.min} max={LIMITS.tablePaddingMm.max} step={0.25} value={item.paddingMm} format={(v) => formatMm(v, 2)} hint={across ? 'Space between the text and the tape edges.' : 'Space between the text and the column edges.'} onchange={(paddingMm) => set({ paddingMm }, 'padding')} />

<div class="toggles">
  <Switch label="Italic" checked={item.italic} onchange={(italic) => set({ italic })} />
  <Switch label="Grid lines" hint="Lines around and between the cells." checked={item.grid} onchange={(grid) => set({ grid })} />
  <Switch label="Cut marks" hint={cutting ? 'Not needed: the printer cuts between the columns.' : 'Short ticks at the tape edges where to cut between the columns.'} disabled={cutting} checked={item.cutMarks && !cutting} onchange={(cutMarks) => set({ cutMarks })} />
  {#if cutter}
    <Switch label="Cut between columns" hint="The printer cuts after every column: one piece per column." checked={item.cutBetween} onchange={setCutBetween} />
  {:else}
    <p class="hint">This printer has no cutter: turn on Cut marks and cut the pieces apart with scissors.</p>
  {/if}
</div>
{#if item.cutBetween && cutter}
  {#if cutting && studio.doc.frame}
    <p class="hint warn" role="note">The label frame goes around the whole strip: the first and last pieces are longer and the middle pieces are open at the ends. Turn the frame off and use Grid lines to box every piece.</p>
  {/if}
  {#if !studio.doc.print.autoCut}
    <p class="hint warn" role="note">Cut each is off: the strip won’t be cut. Turn on Cut each in the print options.</p>
  {:else if pieces}
    <p class="hint pieces" role="status">{pieces}. Every piece has the printer’s feed margin at both ends; the leader is fed once.</p>
  {/if}
{/if}

<style>
  .cells-link {
    margin: 0;
    font-size: 13px;
    color: var(--text-muted);
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
    min-height: 28px;
  }
  .fixed {
    margin: 0;
    min-height: 36px;
    display: flex;
    align-items: center;
  }
  .missing {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-m);
    background: var(--warn-soft);
    font-size: 13px;
  }
  .missing p {
    margin: 0;
  }
  .toggles {
    display: grid;
    gap: var(--space-2);
  }
  .hint {
    margin: 0;
  }
  @media (pointer: coarse) {
    .link {
      min-height: 44px;
    }
  }
</style>
