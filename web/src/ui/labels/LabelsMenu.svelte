<!-- W4 — label library menu: New, Open (LibraryDialog, list from W5 LabelStore), Import/Export
     (W5 persist-files), Share link (W5 persist-share), plus the inline label name. -->
<script lang="ts">
  import Menu, { type MenuItem } from '../common/Menu.svelte'
  import Icon from '../common/Icon.svelte'
  import { getStudio } from '../state/studio.svelte'

  const studio = getStudio()
  let fileInput: HTMLInputElement | undefined = $state()

  const items: MenuItem[] = [
    { id: 'new', label: 'New label', icon: 'file-plus', run: () => studio.newLabel() },
    { id: 'open', label: 'Open…', icon: 'folder', run: () => (studio.libraryOpen = true) },
    { id: 'import', label: 'Import file…', icon: 'upload', separatorBefore: true, run: () => fileInput?.click() },
    { id: 'export', label: 'Export file', icon: 'download', run: () => void studio.exportFile() },
    { id: 'share', label: 'Copy share link', icon: 'link', run: () => void studio.copyShareLink() },
  ]

  function onfile(e: Event & { currentTarget: HTMLInputElement }) {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (file) void studio.importFile(file)
  }
</script>

<div class="labels">
  <Menu label="Labels" {items}>
    {#snippet trigger()}<Icon name="tag" size={16} /><span class="trigger-text">Labels</span><Icon name="chevron-down" size={14} />{/snippet}
  </Menu>
  <input
    class="name"
    aria-label="Label name"
    value={studio.doc.name}
    maxlength="80"
    spellcheck="false"
    oninput={(e) => studio.updateDoc({ name: e.currentTarget.value }, 'doc:name')}
    onblur={(e) => {
      if (!e.currentTarget.value.trim()) studio.updateDoc({ name: 'Untitled label' })
    }}
  />
  {#if studio.readOnly}<span class="ro" title="Made with a newer version; edits are saved as a copy">Read-only</span>{/if}
  <input bind:this={fileInput} type="file" accept=".json,.ptlabel.json,application/json" hidden onchange={onfile} />
</div>

<style>
  .labels {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    min-width: 0;
  }
  .name {
    min-width: 0;
    width: clamp(110px, 16vw, 240px);
    height: 32px;
    padding: 0 var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-s);
    background: transparent;
    font-weight: 600;
    text-overflow: ellipsis;
  }
  .name:hover {
    border-color: var(--border);
  }
  .name:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 0;
    background: var(--surface);
  }
  .ro {
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--warn-soft);
    color: var(--warn);
    font-size: 12px;
    font-weight: 600;
  }
  @media (max-width: 640px) {
    .trigger-text {
      display: none;
    }
    .name {
      width: auto;
      flex: 1 1 0;
    }
  }
</style>
