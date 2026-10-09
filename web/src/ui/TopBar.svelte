<!-- W4 — header: brand, label menu + name, undo/redo, theme, shortcuts, diagnostics, connection
     chip with Reconnect / Disconnect (ARCHITECTURE.md §6.4). Design-only mode (no Web Serial /
     WebUSB, e.g. iPhone): on phones and tablets (narrow, or a touch screen: an iPhone in
     landscape is 667–932 px wide) the idle chip is hidden, the banner offers the hand-off. -->
<script lang="ts">
  import { getStudio } from './state/studio.svelte'
  import StatusChip from './connect/StatusChip.svelte'
  import LabelsMenu from './labels/LabelsMenu.svelte'
  import Icon from './common/Icon.svelte'
  import Menu, { type MenuItem } from './common/Menu.svelte'
  import { connectFailed, isConnected, modKey } from './state/view-model'

  const studio = getStudio()
  const mod = modKey(studio.isMac ? 'mac' : 'other')
  const state = $derived(studio.conn.state)
  const connecting = $derived(state === 'opening' || state === 'waking' || state === 'handshaking')
  // Nothing was ever opened after a failed connect: there is nothing to disconnect.
  const canDisconnect = $derived(isConnected(state) || state === 'lost' || state === 'no-reply' || (state === 'error' && !connectFailed(studio.conn)))
  const THEMES = ['system', 'light', 'dark'] as const
  const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' } as const
  const THEME_LABEL = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' } as const
  const theme = $derived(studio.prefs.theme)
  const nextTheme = $derived(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? 'system')
  function cycleTheme() {
    studio.setTheme(nextTheme)
  }
  // Narrow screens: Diagnostics and Shortcuts (and, on phones, the theme) move into this menu
  // instead of disappearing.
  const moreItems: MenuItem[] = $derived([
    { id: 'theme', label: `Use ${THEME_LABEL[nextTheme].toLowerCase()}`, icon: THEME_ICON[nextTheme], run: cycleTheme },
    { id: 'diagnostics', label: 'Diagnostics', icon: 'activity', run: () => studio.setView('diagnostics') },
    { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard', run: () => (studio.shortcutsOpen = true) },
    { id: 'licences', label: 'Licences', icon: 'info', run: () => window.open(`${import.meta.env.BASE_URL}licenses/`, '_blank', 'noopener') },
  ])
</script>

<header class="topbar">
  <div class="brand">
    <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width="26" height="26" />
    <span class="wordmark">ptouch <strong>studio</strong></span>
  </div>
  <LabelsMenu />
  <div class="history" role="group" aria-label="History">
    <button type="button" class="btn ghost icon" disabled={!studio.canUndo} onclick={() => studio.undo()} aria-label="Undo" title="Undo ({mod}+Z)"><Icon name="undo" /></button>
    <button type="button" class="btn ghost icon" disabled={!studio.canRedo} onclick={() => studio.redo()} aria-label="Redo" title="Redo ({mod}+Shift+Z)"><Icon name="redo" /></button>
  </div>
  <div class="spacer"></div>
  <div class="tools">
    <button type="button" class="btn ghost icon hide-xs" onclick={cycleTheme} aria-label="{THEME_LABEL[theme]} (click to change)" title={THEME_LABEL[theme]}><Icon name={THEME_ICON[theme]} /></button>
    <button type="button" class="btn ghost icon hide-sm" onclick={() => (studio.shortcutsOpen = true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)"><Icon name="keyboard" /></button>
    <button type="button" class="btn ghost diag hide-sm" onclick={() => studio.setView('diagnostics')} title="Diagnostics" aria-label="Diagnostics"><Icon name="activity" size={16} /><span class="diag-text">Diagnostics</span></button>
    <div class="show-sm">
      <Menu label="More" items={moreItems} align="end">
        {#snippet trigger()}<Icon name="more" size={18} /><span class="visually-hidden">More</span>{/snippet}
      </Menu>
    </div>
  </div>
  <div class="conn" class:design-only={studio.designOnly && state === 'disconnected'}>
    <StatusChip />
    {#if connecting}
      <button type="button" class="btn small" onclick={() => studio.cancelConnect()}>Cancel</button>
    {:else if state === 'lost' || state === 'no-reply' || state === 'error'}
      <button type="button" class="btn small" onclick={() => studio.reconnect()}><Icon name="refresh" size={16} />Reconnect</button>
    {/if}
    {#if canDisconnect}
      <button type="button" class="btn ghost icon small" disabled={state === 'printing'} onclick={() => studio.disconnect()} aria-label="Disconnect printer" title="Disconnect"><Icon name="eject" size={16} /></button>
    {/if}
  </div>
</header>

<style>
  .topbar {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    min-height: 56px;
    padding: var(--space-2) var(--space-4);
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--border);
  }
  .brand {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    font-size: 16px;
    letter-spacing: -0.01em;
  }
  .wordmark strong {
    color: var(--accent);
  }
  .history,
  .tools,
  .conn {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .conn {
    gap: var(--space-2);
    min-width: 0;
  }
  .spacer {
    flex: 1;
  }
  @media (max-width: 1100px) {
    .diag-text {
      display: none;
    }
    .diag {
      width: 36px;
      padding: 0;
    }
  }
  .show-sm {
    display: none;
  }
  @media (max-width: 860px) {
    .hide-sm {
      display: none;
    }
    .show-sm {
      display: flex;
    }
    .wordmark {
      display: none;
    }
  }
  @media (max-width: 600px) {
    .topbar {
      padding: var(--space-2) var(--space-3);
      gap: var(--space-2);
    }
    .spacer {
      display: none;
    }
    .topbar > :global(.labels) {
      flex: 1 1 0;
    }
    .conn {
      order: 10;
      width: 100%;
    }
    .conn > :global(.chip) {
      flex: 1;
      justify-content: center;
    }
    /* Only the virtual printer is reachable here; DesignOnlyBanner offers "Send to computer". */
    .conn.design-only {
      display: none;
    }
  }
  /* Touch devices in design-only mode at any width (iPhone landscape, iPad): "Connect printer"
     would only lead to the virtual printer; DesignOnlyBanner offers "Send to computer". */
  @media (pointer: coarse) {
    .conn.design-only {
      display: none;
    }
  }
  /* 360–420 px phones: the label name needs the room more than the logo and the theme button
     (the theme is in "More"). */
  @media (max-width: 420px) {
    .brand,
    .hide-xs {
      display: none;
    }
  }
</style>
