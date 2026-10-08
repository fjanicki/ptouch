<!-- W4 — segmented control = accessible radio group (roving tabindex, arrow keys). -->
<script lang="ts" generics="T extends string | number">
  import Icon from './Icon.svelte'

  interface Option {
    value: T
    label: string
    icon?: string
  }
  let {
    label,
    options,
    value,
    onchange,
    iconOnly = false,
    hideLabel = false,
    size = 'normal',
  }: {
    label: string
    options: readonly Option[]
    value: T
    onchange: (v: T) => void
    iconOnly?: boolean
    hideLabel?: boolean
    size?: 'normal' | 'small'
  } = $props()

  const id = $props.id()
  let group: HTMLDivElement | undefined = $state()

  function onkeydown(e: KeyboardEvent, index: number) {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    let next = index
    if (dir) next = (index + dir + options.length) % options.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = options.length - 1
    else return
    e.preventDefault()
    const opt = options[next]
    if (!opt) return
    onchange(opt.value)
    group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
  }
</script>

<div class="seg-wrap">
  <span class="field-label" class:visually-hidden={hideLabel} id="{id}-label">{label}</span>
  <div class="seg {size}" role="radiogroup" aria-labelledby="{id}-label" bind:this={group}>
    {#each options as o, i (o.value)}
      <button
        type="button"
        role="radio"
        aria-checked={o.value === value}
        tabindex={o.value === value || (i === 0 && !options.some((x) => x.value === value)) ? 0 : -1}
        aria-label={iconOnly ? o.label : undefined}
        title={iconOnly ? o.label : undefined}
        onclick={() => onchange(o.value)}
        onkeydown={(e) => onkeydown(e, i)}
      >
        {#if o.icon}<Icon name={o.icon} size={16} />{/if}
        {#if !iconOnly}<span>{o.label}</span>{/if}
      </button>
    {/each}
  </div>
</div>

<style>
  .seg-wrap {
    display: grid;
    gap: var(--space-1);
    min-width: 0;
  }
  .seg {
    display: flex;
    padding: 2px;
    gap: 2px;
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: var(--surface-2);
    min-width: 0;
  }
  button {
    flex: 1 1 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 0;
    min-height: 30px;
    padding: 0 var(--space-2);
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 13px;
    white-space: nowrap;
  }
  .small button {
    min-height: 26px;
    padding: 0 6px;
    font-size: 12px;
  }
  button span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  button:hover {
    color: var(--text);
  }
  /* Selected: accent tint + accent outline (≥ 3:1 against the track in both themes, WCAG
     1.4.11), not just a lighter surface. */
  button[aria-checked='true'] {
    background: var(--accent-soft);
    color: var(--text);
    font-weight: 600;
    box-shadow: inset 0 0 0 2px var(--accent);
  }
  button:focus-visible {
    outline-offset: 0;
  }
</style>
