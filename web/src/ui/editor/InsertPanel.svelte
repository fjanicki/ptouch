<!-- W4 — INSERT tiles: text, icon, QR, barcode, image, shape, spacer (doc/ops.addItem after the
     selected block). Image asks for a file first. -->
<script lang="ts">
  import Icon from '../common/Icon.svelte'
  import { errorMessage, getStudio } from '../state/studio.svelte'

  const studio = getStudio()
  let fileInput: HTMLInputElement | undefined = $state()

  async function onfile(e: Event & { currentTarget: HTMLInputElement }) {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (!file) return
    try {
      const blobRef = await studio.store.putBlob(file)
      studio.insert('image', { blobRef })
    } catch (err) {
      studio.toast('error', 'Could not add the image', errorMessage(err))
    }
  }

  const TILES: { id: string; label: string; icon: string; run: () => void }[] = [
    { id: 'text', label: 'Text', icon: 'type', run: () => studio.insert('text', { text: 'Text' }) },
    { id: 'icon', label: 'Icon', icon: 'star', run: () => studio.insert('icon') },
    { id: 'qr', label: 'QR code', icon: 'qr', run: () => studio.insert('code') },
    { id: 'barcode', label: 'Barcode', icon: 'barcode', run: () => studio.insert('code', { symbology: 'code128', data: 'ABC-12345', moduleDots: 2, showText: true }) },
    { id: 'image', label: 'Image', icon: 'image', run: () => fileInput?.click() },
    { id: 'shape', label: 'Shape', icon: 'square', run: () => studio.insert('shape') },
    { id: 'spacer', label: 'Spacer', icon: 'space', run: () => studio.insert('spacer') },
  ]
</script>

<nav class="insert" aria-label="Insert block">
  <h2 class="panel-title">Insert</h2>
  <div class="tiles">
    {#each TILES as t (t.id)}
      <button type="button" class="tile" onclick={t.run} aria-label="Insert {t.label}">
        <Icon name={t.icon} size={20} />
        <span>{t.label}</span>
      </button>
    {/each}
  </div>
  <input bind:this={fileInput} type="file" accept="image/*" hidden onchange={onfile} />
</nav>

<style>
  .insert {
    display: grid;
    gap: var(--space-2);
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(76px, 1fr));
    gap: var(--space-2);
  }
  .tile {
    display: grid;
    justify-items: center;
    gap: 4px;
    padding: var(--space-2) var(--space-1);
    min-height: 60px;
    border: 1px solid var(--border);
    border-radius: var(--radius-m);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    font-size: 12px;
    transition:
      border-color 120ms var(--ease),
      background-color 120ms var(--ease),
      transform 120ms var(--ease);
  }
  .tile :global(svg) {
    color: var(--accent);
  }
  .tile:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .tile:active {
    transform: scale(0.97);
  }
</style>
