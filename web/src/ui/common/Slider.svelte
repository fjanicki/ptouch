<!-- W4 — labelled range slider with a value readout. -->
<script lang="ts">
  let {
    label,
    value,
    onchange,
    min,
    max,
    step = 1,
    format = (v: number) => String(v),
    hint,
  }: {
    label: string
    value: number
    onchange: (v: number) => void
    min: number
    max: number
    step?: number
    format?: (v: number) => string
    hint?: string
  } = $props()
  const id = $props.id()
</script>

<div class="field">
  <div class="head">
    <label class="field-label" for={id}>{label}</label>
    <output for={id}>{format(value)}</output>
  </div>
  <input {id} type="range" {min} {max} {step} {value} aria-valuetext={format(value)} aria-describedby={hint ? `${id}-hint` : undefined} oninput={(e) => onchange(Number(e.currentTarget.value))} />
  {#if hint}<p class="hint" id="{id}-hint">{hint}</p>{/if}
</div>

<style>
  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  output {
    font: 12px var(--font-mono);
    color: var(--text-muted);
  }
  input {
    margin: 2px 0;
  }
</style>
