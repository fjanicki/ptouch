<!-- W4 — friendly screen for browsers without Web Serial / WebUSB (Safari, iOS, Firefox Android,
     Brave with serial off). "Design labels anyway" continues with the editor (virtual printer).
     P5: on iPhone/iPad (every iOS browser is WebKit) it is a design-only welcome instead: design
     here, send the label to a computer, print there; plus the Add to Home Screen tip. -->
<script lang="ts">
  import type { SupportInfo } from '../printer'
  import Icon from './common/Icon.svelte'
  import { appleDevice, isStandalone } from './handoff/handoff'

  let { support, oncontinue }: { support: SupportInfo; oncontinue: () => void } = $props()

  const ios = $derived(support.platform === 'ios')
  const device = appleDevice(navigator)
  const installed = isStandalone(navigator as Navigator & { standalone?: boolean }, (q) => window.matchMedia(q))

  const why = $derived.by(() => {
    if (support.engine === 'webkit') return 'Safari doesn’t support Web Serial or WebUSB, which this app uses to talk to the printer.'
    if (support.brave) return 'Brave turns Web Serial off by default. Enable it under brave://settings/content (Serial ports), or use Chrome or Edge.'
    if (support.engine === 'gecko' && support.platform === 'android') return 'Firefox for Android doesn’t support Web Serial yet.'
    if (support.engine === 'gecko') return 'This version of Firefox doesn’t offer Web Serial. Firefox 151 or later (desktop) can connect over Bluetooth serial ports.'
    return 'This browser doesn’t support Web Serial or WebUSB, which this app uses to talk to the printer.'
  })
</script>

<main class="unsupported">
  <div class="card">
    {#if ios}
      <span class="glyph"><Icon name="smartphone" size={30} /></span>
      <h1>Design on your {device}, print from a computer</h1>
      <p class="why">On {device} you can design labels here; printing happens from a computer with Chrome or Edge. Apple doesn’t allow Web Serial or WebUSB, which this app uses to reach the printer, in any iOS browser.</p>
      <div class="use">
        <strong>To print a label:</strong>
        <ol>
          <li><span>Design it here. Your labels stay on this {device}.</span></li>
          <li><span>Use <strong>Labels → Send to computer</strong> (AirDrop, Messages or a link).</span></li>
          <li><span>Open it on a Mac or PC in <strong>Google Chrome</strong> or <strong>Microsoft Edge</strong> and print.</span></li>
        </ol>
      </div>
      <div class="actions">
        <button type="button" class="btn primary" onclick={oncontinue}>Start designing</button>
      </div>
      {#if !installed}
        <p class="hint">Tip: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong> to open the studio like an app. It works offline.</p>
      {/if}
    {:else}
      <span class="glyph"><Icon name="printer" size={30} /></span>
      <h1>This browser can’t talk to label printers</h1>
      <p class="why">{why}</p>
      <div class="use">
        <strong>To print, open this page in:</strong>
        <ul>
          <li><Icon name="check" size={16} /> <span><strong>Google Chrome</strong> or <strong>Microsoft Edge</strong> on Windows, macOS, Linux or ChromeOS</span></li>
          <li><Icon name="check" size={16} /> <span><strong>Chrome on Android</strong> (pair the printer in Android settings first)</span></li>
        </ul>
      </div>
      <div class="actions">
        <button type="button" class="btn primary" onclick={oncontinue}>Design labels anyway</button>
        <a class="btn" href="https://www.google.com/chrome/" target="_blank" rel="noopener noreferrer">Get Chrome<Icon name="chevron-right" size={16} /></a>
      </div>
      <p class="hint">You can still design, save and export labels here, then print them from a supported browser.</p>
    {/if}
  </div>
</main>

<style>
  .unsupported {
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: var(--space-4);
  }
  .card {
    max-width: 560px;
    padding: var(--space-6) var(--space-5);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-l);
    box-shadow: var(--shadow-2);
    display: grid;
    gap: var(--space-4);
  }
  .glyph {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: 16px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  h1 {
    margin: 0;
    font-size: 24px;
    letter-spacing: -0.01em;
  }
  .why {
    margin: 0;
    font-size: 15px;
    color: var(--text-muted);
  }
  ul {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
    display: grid;
    gap: var(--space-2);
  }
  ol {
    margin: var(--space-2) 0 0;
    padding-left: 1.4em;
    display: grid;
    gap: var(--space-2);
  }
  ul li {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
  }
  ul li :global(svg) {
    color: var(--ok);
    transform: translateY(3px);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
</style>
