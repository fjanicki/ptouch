<!-- W4 — labelled number input with unit; commits valid values while typing, clamps on blur. -->
<script lang="ts">
  let {
    label,
    value,
    onchange,
    min,
    max,
    step = 1,
    unit,
    hint,
    disabled = false,
  }: {
    label: string
    value: number
    onchange: (v: number) => void
    min?: number
    max?: number
    step?: number
    unit?: string
    hint?: string
    disabled?: boolean
  } = $props()

  const id = $props.id()
  let draft = $state<string | null>(null)
  const shown = $derived(draft ?? String(round(value)))

  function round(v: number): number {
    return Math.round(v * 100) / 100
  }
  function clamp(v: number): number {
    if (min !== undefined) v = Math.max(min, v)
    if (max !== undefined) v = Math.min(max, v)
    return v
  }
  function oninput(e: Event & { currentTarget: HTMLInputElement }) {
    draft = e.currentTarget.value
    const v = Number(draft.replace(',', '.'))
    if (draft.trim() !== '' && Number.isFinite(v) && clamp(v) === v) onchange(v)
  }
  function onblur() {
    if (draft === null) return
    const v = Number(draft.replace(',', '.'))
    draft = null
    if (Number.isFinite(v) && v !== value) onchange(clamp(v))
  }
</script>

<div class="field">
  <label class="field-label" for={id}>{label}</label>
  <div class="num" class:has-unit={!!unit}>
    <input
      {id}
      class="input"
      type="number"
      inputmode="decimal"
      {min}
      {max}
      {step}
      {disabled}
      value={shown}
      aria-describedby={hint ? `${id}-hint` : undefined}
      {oninput}
      {onblur}
    />
    {#if unit}<span class="unit" aria-hidden="true">{unit}</span>{/if}
  </div>
  {#if hint}<p class="hint" id="{id}-hint">{hint}</p>{/if}
</div>

<style>
  .num {
    position: relative;
  }
  .has-unit .input {
    padding-right: 36px;
  }
  .unit {
    position: absolute;
    right: 10px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-muted);
    font-size: 12px;
    pointer-events: none;
  }
  input::-webkit-inner-spin-button {
    opacity: 0.6;
  }
</style>
