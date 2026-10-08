<!-- W4 — keyboard shortcuts reference (opened with "?" or from the top bar). -->
<script lang="ts">
  import Icon from './common/Icon.svelte'
  import Switch from './common/Switch.svelte'
  import { getStudio } from './state/studio.svelte'
  import { shortcutList } from './state/shortcuts'
  import { modKey } from './state/view-model'

  const studio = getStudio()
  let dialog: HTMLDialogElement | undefined = $state()
  const rows = shortcutList(modKey(studio.isMac ? 'mac' : 'other'))

  $effect(() => {
    if (studio.shortcutsOpen) {
      if (!dialog?.open) dialog?.showModal()
    } else if (dialog?.open) dialog.close()
  })
</script>

<dialog class="modal" bind:this={dialog} onclose={() => (studio.shortcutsOpen = false)} aria-labelledby="shortcuts-title">
  <header>
    <h2 id="shortcuts-title">Keyboard shortcuts</h2>
    <button type="button" class="btn ghost icon" aria-label="Close" onclick={() => (studio.shortcutsOpen = false)}><Icon name="x" /></button>
  </header>
  <dl>
    {#each rows as r (r.label)}
      <dt>{#each r.keys as k, i (i)}<kbd>{k}</kbd>{/each}</dt>
      <dd>{r.label}</dd>
    {/each}
  </dl>
  <div class="prefs">
    <Switch
      label="Single-key shortcuts (+ − 0 1 [ ] ?)"
      hint="They only act on the page, the preview and the block list, never while a control has focus. Turn them off if they clash with your screen reader."
      checked={studio.prefs.singleKeyShortcuts}
      onchange={(on) => studio.setSingleKeyShortcuts(on)}
    />
  </div>
</dialog>

<style>
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-4) var(--space-4) 0 var(--space-5);
  }
  h2 {
    margin: 0;
    font-size: 18px;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-2) var(--space-4);
    margin: 0;
    padding: var(--space-4) var(--space-5) var(--space-5);
  }
  dt {
    display: flex;
    gap: 4px;
  }
  dd {
    margin: 0;
    align-self: center;
  }
  .prefs {
    display: grid;
    gap: var(--space-1);
    padding: 0 var(--space-5) var(--space-5);
  }

</style>
