<!-- P1 (docs/STUDIO-V1-PLAN.md) — under a text/code field: lists the `{{variables}}` used in
     `text`, highlights unknown ones (doc/variables.ts) and offers the batch panel. Mounted by
     TextProps and CodeProps. Renders nothing when `text` has no placeholders. -->
<script lang="ts">
  import { placeholderNames, variableKind, type VariableKind } from '../../doc/variables'
  import Icon from '../common/Icon.svelte'
  import { getStudio } from '../state/studio.svelte'
  import { revealBatchPanel } from './panel-state.svelte'

  let { text }: { text: string } = $props()
  const studio = getStudio()

  const KIND_TEXT: Record<VariableKind, string> = {
    column: 'column',
    counter: 'counter',
    date: 'date',
    ssid: 'network name',
    missing: 'unknown',
  }

  const vars = $derived(placeholderNames(text).map((name) => ({ name, kind: variableKind(studio.doc, name) })))
  const unknown = $derived(vars.filter((v) => v.kind === 'missing').length)
</script>

{#if vars.length}
  <div class="vars" role="group" aria-label="Variables in this field">
    <ul>
      {#each vars as v (v.name)}
        <li class="chip" class:missing={v.kind === 'missing'}>
          {#if v.kind === 'missing'}<Icon name="alert" size={12} />{/if}
          <code>{`{{${v.name}}}`}</code>
          <span class="kind">{KIND_TEXT[v.kind]}</span>
        </li>
      {/each}
    </ul>
    {#if unknown}
      <p class="hint error">
        {unknown === 1 ? 'This variable is not defined' : `${unknown} variables are not defined`}: add a column or counter with that name, or fix the spelling.
      </p>
    {/if}
    <button type="button" class="btn small" onclick={() => void revealBatchPanel()}><Icon name="table" size={14} />Edit data…</button>
  </div>
{/if}

<style>
  .vars {
    display: grid;
    gap: var(--space-1);
    justify-items: start;
  }
  ul {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    padding: 1px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-2);
    font-size: 12px;
  }
  .chip code {
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }
  .kind {
    color: var(--text-muted);
  }
  .chip.missing {
    border-color: var(--danger);
    background: var(--danger-soft);
    color: var(--danger);
  }
  .chip.missing .kind {
    color: var(--danger);
    font-weight: 600;
  }
</style>
