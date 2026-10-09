<!-- P1 (docs/STUDIO-V1-PLAN.md) — batch counters ({{n}} = start + label × step, zero-padded),
     each with a live example ("001, 002, 003, …"). At most LIMITS.batchCounters. -->
<script lang="ts">
  import { LIMITS, type BatchCounter, type BatchData } from '../../doc/schema'
  import Icon from '../common/Icon.svelte'
  import NumberField from '../common/NumberField.svelte'
  import { getStudio } from '../state/studio.svelte'
  import { addCounter, counterExample, nameProblem, removeCounter, updateCounter } from './batch-model'

  let { batch }: { batch: BatchData } = $props()
  const studio = getStudio()
  const id = $props.id()
  let drafts = $state<Record<number, string>>({})

  const save = (b: BatchData, key?: string) => studio.updateDoc({ batch: b }, key)
  const set = (k: number, patch: Partial<BatchCounter>, key: string) => save(updateCounter(batch, k, patch), `batch:counter:${k}:${key}`)

  function commitName(k: number, value: string) {
    const name = value.trim()
    if (name === batch.counters[k]?.name) {
      delete drafts[k]
      return
    }
    if (nameProblem(batch, name, { counter: k })) {
      drafts[k] = value
      return
    }
    delete drafts[k]
    set(k, { name }, 'name')
  }
</script>

<div class="counters">
  {#each batch.counters as c, k (k)}
    {@const draft = drafts[k]}
    {@const problem = draft !== undefined ? nameProblem(batch, draft.trim(), { counter: k }) : undefined}
    <fieldset class="counter">
      <legend><code>{`{{${c.name}}}`}</code> <span class="example">= {counterExample(c)}</span></legend>
      <div class="field">
        <label class="field-label" for="{id}-name-{k}">Name</label>
        <input
          id="{id}-name-{k}"
          class="input mono"
          value={draft ?? c.name}
          spellcheck="false"
          autocomplete="off"
          aria-invalid={problem ? 'true' : undefined}
          aria-describedby={problem ? `${id}-err-${k}` : undefined}
          onchange={(e) => commitName(k, e.currentTarget.value)}
          onkeydown={(e) => e.key === 'Enter' && commitName(k, e.currentTarget.value)}
        />
        {#if problem}<p class="hint error" id="{id}-err-{k}">{problem}</p>{/if}
      </div>
      <NumberField label="Start" value={c.start} min={-LIMITS.counterValue} max={LIMITS.counterValue} onchange={(start) => set(k, { start }, 'start')} />
      <NumberField label="Step" value={c.step} min={-LIMITS.counterValue} max={LIMITS.counterValue} onchange={(step) => set(k, { step }, 'step')} />
      <NumberField label="Digits" value={c.pad} min={LIMITS.counterPad.min} max={LIMITS.counterPad.max} onchange={(pad) => set(k, { pad }, 'pad')} />
      <button type="button" class="btn icon small ghost remove" aria-label="Remove counter {c.name}" title="Remove counter" onclick={() => save(removeCounter(batch, k))}><Icon name="trash" size={14} /></button>
    </fieldset>
  {/each}
  {#if batch.counters.length < LIMITS.batchCounters}
    <button type="button" class="btn small add" onclick={() => save(addCounter(batch))}><Icon name="plus" size={14} />Counter</button>
  {/if}
  <p class="hint">Digits pads with zeros: 3 digits print 001, 002, … Write <code>{'A-{{n}}'}</code> on the label for A-001.</p>
</div>

<style>
  .counters {
    display: grid;
    gap: var(--space-2);
    justify-items: stretch;
  }
  .counter {
    display: grid;
    grid-template-columns: minmax(80px, 1.2fr) repeat(3, minmax(64px, 1fr)) auto;
    align-items: end;
    gap: var(--space-2);
    margin: 0;
    padding: var(--space-2) var(--space-3) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-m);
    min-width: 0;
  }
  legend {
    padding: 0 4px;
    font-size: 13px;
  }
  legend code,
  .mono {
    font-family: var(--font-mono);
  }
  .example {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .add {
    justify-self: start;
  }
  .remove {
    margin-bottom: 3px;
  }
  @media (max-width: 520px) {
    .counter {
      grid-template-columns: 1fr 1fr;
    }
    .remove {
      grid-column: 1 / -1;
      justify-self: end;
    }
  }
</style>
