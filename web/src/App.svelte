<!-- W4 — app shell (ARCHITECTURE.md §6.4): top bar; INSERT + blocks | media bar + preview |
     PROPERTIES; sticky print bar; diagnostics view (W5); unsupported-browser screen; update
     toast (W5). ≥ 1180 px three columns, 860–1180 px two, below one column with the preview
     on top. -->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { Studio, provideStudio } from './ui/state/studio.svelte'
  import TopBar from './ui/TopBar.svelte'
  import ConnectDialog from './ui/connect/ConnectDialog.svelte'
  import MediaBar from './ui/media/MediaBar.svelte'
  import InsertPanel from './ui/editor/InsertPanel.svelte'
  import BlockList from './ui/editor/BlockList.svelte'
  import PropertiesPanel from './ui/editor/PropertiesPanel.svelte'
  import Preview from './ui/preview/Preview.svelte'
  import PrintBar from './ui/print/PrintBar.svelte'
  import UnsupportedBrowser from './ui/UnsupportedBrowser.svelte'
  import ShortcutsDialog from './ui/ShortcutsDialog.svelte'
  import LibraryDialog from './ui/labels/LibraryDialog.svelte'
  import ProblemBanner from './ui/common/ProblemBanner.svelte'
  import Toasts from './ui/common/Toasts.svelte'
  // Diagnostics (probe, virtual printer runs, report) is a separate chunk: most visits never open it.
  const loadDiagnostics = () => import('./ui/diagnostics/Diagnostics.svelte')
  import UpdateToast from './pwa/UpdateToast.svelte'

  const studio = provideStudio(new Studio())
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
{:else if !studio.support.canPrint && !studio.designAnyway}
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
        {#if !studio.support.canPrint}
          <div class="notice" role="status">Design mode: this browser can’t connect to printers. Export the label or open it in Chrome or Edge to print.</div>
        {/if}
        {#if showProblem}
          <ProblemBanner problem={showProblem} onaction={(a) => studio.handleProblemAction(a)} />
        {/if}
        <MediaBar />
        <Preview />
      </main>
      <div class="right">
        <PropertiesPanel />
      </div>
    </div>
    <PrintBar />
  </div>
  <ConnectDialog />
  <LibraryDialog />
  <ShortcutsDialog />
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
    /* Phones/tablets: the tape preview comes first, right under any banner. */
    .center > :global(.preview) {
      order: -1;
    }
    .center > :global(.banner),
    .center > .notice {
      order: -2;
    }
  }
</style>
