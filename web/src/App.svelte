<!-- App shell (ARCHITECTURE.md §6.4): top bar; INSERT + blocks | media bar + preview + batch |
     PROPERTIES; sticky print bar; diagnostics view; unsupported-browser screen; update toast.
     ≥ 1180 px three columns, 860–1180 px two, below one column with the preview on top.
     Lead-owned since studio v1: the v1 packages' entry points (BatchPanel, DesignOnlyBanner and
     the dialogs) are mounted here and filled by their packages (docs/STUDIO-V1-PLAN.md); the
     dialogs load on their first open. The compact quick text sizes under the preview belong to
     P-size (docs/FONTS-AND-SIZE-PLAN.md). A selected table's "Table cells" card goes under the
     preview (lazy, with the table inspector: docs/TABLE-PLAN.md §12). -->
<script lang="ts">
  import { onDestroy, onMount, type Component } from 'svelte'
  import type { TableItem } from './doc/schema'
  import { Studio, provideStudio, type StudioDialog } from './ui/state/studio.svelte'
  import TopBar from './ui/TopBar.svelte'
  import ConnectDialog from './ui/connect/ConnectDialog.svelte'
  import MediaBar from './ui/media/MediaBar.svelte'
  import InsertPanel from './ui/editor/InsertPanel.svelte'
  import BlockList from './ui/editor/BlockList.svelte'
  import PropertiesPanel from './ui/editor/PropertiesPanel.svelte'
  import Preview from './ui/preview/Preview.svelte'
  import PrintBar from './ui/print/PrintBar.svelte'
  import UnsupportedBrowser from './ui/UnsupportedBrowser.svelte'
  import ProblemBanner from './ui/common/ProblemBanner.svelte'
  import Toasts from './ui/common/Toasts.svelte'
  import BatchPanel from './ui/batch/BatchPanel.svelte'
  import DesignOnlyBanner from './ui/handoff/DesignOnlyBanner.svelte'
  import TextSizeQuick from './ui/editor/props/TextSizeQuick.svelte'
  // Diagnostics (probe, virtual printer runs, report) is a separate chunk: most visits never open it.
  const loadDiagnostics = () => import('./ui/diagnostics/Diagnostics.svelte')
  import UpdateToast from './pwa/UpdateToast.svelte'

  // The v1 dialogs are separate chunks too (entry-chunk budget, .github/workflows/web.yml): each
  // loads on its first open and then stays mounted, so its own open/close and focus logic is kept.
  const DIALOGS: Record<StudioDialog, () => Promise<{ default: Component }>> = {
    templates: () => import('./ui/templates/TemplateGallery.svelte'),
    history: () => import('./ui/history/HistoryDialog.svelte'),
    export: () => import('./ui/export/ExportDialog.svelte'),
    handoff: () => import('./ui/handoff/HandoffDialog.svelte'),
    fonts: () => import('./ui/fonts/FontManager.svelte'),
    'share-secrets': () => import('./ui/share/SecretsDialog.svelte'),
  }

  const studio = provideStudio(new Studio())
  // "Open label" and the shortcut reference are lazy too (docs/TABLE-PLAN.md T15): mounted on
  // their first open (their own effect then calls showModal) and kept mounted afterwards.
  let Library = $state<Component | null>(null)
  let Shortcuts = $state<Component | null>(null)
  const lazyDialog = (open: boolean, have: Component | null, load: () => Promise<{ default: Component }>, done: (c: Component) => void, close: () => void): void => {
    if (!open || have) return
    load().then(
      (m) => done(m.default),
      () => {
        close()
        studio.toast('error', 'This dialog could not be loaded.', 'Check your connection and reload the page.')
      },
    )
  }
  $effect(() => lazyDialog(studio.libraryOpen, Library, () => import('./ui/labels/LibraryDialog.svelte'), (c) => (Library = c), () => (studio.libraryOpen = false)))
  $effect(() => lazyDialog(studio.shortcutsOpen, Shortcuts, () => import('./ui/ShortcutsDialog.svelte'), (c) => (Shortcuts = c), () => (studio.shortcutsOpen = false)))
  // The table cells card: the table editor's chunk (the inspector reports a failed load).
  let TableCells = $state<Component<{ item: TableItem }> | null>(null)
  $effect(() => {
    if (studio.selected?.kind === 'table' && !TableCells) import('./ui/editor/props/table-editor').then((m) => (TableCells = m.TableCells), () => {})
  })
  let dialogs = $state<Partial<Record<StudioDialog, Component>>>({})
  const loading = new Set<StudioDialog>()
  $effect(() => {
    const id = studio.dialog
    if (!id || dialogs[id] || loading.has(id)) return
    loading.add(id)
    DIALOGS[id]()
      .then((m) => {
        dialogs[id] = m.default
      })
      .catch(() => {
        if (studio.dialog === id) studio.closeDialog()
        studio.toast('error', 'This dialog could not be loaded.', 'Check your connection and reload the page.')
      })
      .finally(() => loading.delete(id))
  })
  onMount(() => {
    void studio.start()
  })
  onDestroy(() => studio.dispose())

  const showProblem = $derived(studio.conn.problem && !studio.connectOpen ? studio.conn.problem : null)
</script>

<svelte:window onkeydown={(e) => studio.handleKey(e)} onhashchange={() => studio.onHashChange()} />

{#if studio.view === 'diagnostics'}
  {#await loadDiagnostics()}
    <p class="loading-view" role="status">Loading diagnostics…</p>
  {:then { default: Diagnostics }}
    <Diagnostics onclose={() => studio.setView('studio')} />
  {:catch}
    <p class="loading-view" role="alert">Diagnostics could not be loaded. Check your connection and reload the page.</p>
  {/await}
{:else if studio.designOnly && !studio.designAnyway}
  <UnsupportedBrowser support={studio.support} oncontinue={() => studio.continueDesigning()} />
{:else}
  <div class="shell">
    <h1 class="visually-hidden">ptouch studio — {studio.doc.name}</h1>
    <TopBar />
    <div class="workspace">
      <div class="left">
        <InsertPanel />
        <BlockList />
      </div>
      <main class="center" aria-label="Label editor">
        {#if studio.readOnly}
          <div class="notice" role="status">This label was made with a newer version of ptouch studio. It opened read-only; your first edit saves a copy.</div>
        {/if}
        {#if studio.designOnly}
          <DesignOnlyBanner />
        {/if}
        {#if showProblem}
          <ProblemBanner problem={showProblem} onaction={(a) => studio.handleProblemAction(a)} />
        {/if}
        <MediaBar />
        {#if studio.selected?.kind === 'text'}
          <!-- Desktop: right above the preview (never under the print bar); phones: right under it. -->
          <div class="near-size">
            <TextSizeQuick item={studio.selected} variant="compact" />
          </div>
        {/if}
        <Preview />
        {#if TableCells && studio.selected?.kind === 'table'}
          <div class="near-cells"><TableCells item={studio.selected} /></div>
        {/if}
        <BatchPanel />
      </main>
      <div class="right">
        <PropertiesPanel />
      </div>
    </div>
    <PrintBar />
  </div>
  <ConnectDialog />
  {#if Library}<Library />{/if}
  {#if Shortcuts}<Shortcuts />{/if}
  {#each Object.values(dialogs) as Dialog (Dialog)}
    <Dialog />
  {/each}
  <Toasts />
{/if}
<UpdateToast busy={studio.printing || studio.conn.state === 'printing'} />
<div class="visually-hidden" aria-live="polite" aria-atomic="true">{studio.announcement}</div>

<style>
  .shell {
    display: grid;
    grid-template-rows: auto 1fr auto;
    min-height: 100vh;
    min-height: 100dvh;
  }
  .workspace {
    display: grid;
    grid-template-columns: minmax(220px, 260px) minmax(0, 1fr) minmax(260px, 320px);
    grid-template-areas: 'left center right';
    gap: var(--space-4);
    padding: var(--space-4);
    align-items: start;
    width: 100%;
    max-width: 1680px;
    margin: 0 auto;
  }
  .left {
    grid-area: left;
    display: grid;
    gap: var(--space-5);
    align-content: start;
    min-width: 0;
  }
  .center {
    grid-area: center;
    display: grid;
    gap: var(--space-3);
    align-content: start;
    min-width: 0;
  }
  .right {
    grid-area: right;
    min-width: 0;
  }
  .near-cells {
    min-width: 0;
  }
  @media (min-width: 1181px) {
    .left,
    .right {
      position: sticky;
      top: 72px;
      max-height: calc(100dvh - 72px - var(--printbar-h, 72px) - 16px);
      overflow: auto;
      padding-bottom: var(--space-2);
      scrollbar-width: thin;
    }
  }
  .loading-view {
    padding: var(--space-6) var(--space-4);
    text-align: center;
    color: var(--text-muted);
  }
  .notice {
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-m);
    background: var(--accent-soft);
    color: var(--text);
  }
  @media (max-width: 1180px) {
    .workspace {
      grid-template-columns: minmax(220px, 260px) minmax(0, 1fr);
      grid-template-areas:
        'left center'
        'left right';
    }
  }
  @media (max-width: 860px) {
    .workspace {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas:
        'center'
        'left'
        'right';
      padding: var(--space-3);
      gap: var(--space-3);
    }
    /* Phones/tablets: the tape preview comes first, right under any banner, then the quick text
       sizes, then the tape settings. */
    .center > :global(.preview) {
      order: -2;
    }
    .center > .near-size,
    .center > .near-cells {
      order: -1;
    }
    .center > :global(.banner),
    .center > .notice {
      order: -3;
    }
  }
</style>
