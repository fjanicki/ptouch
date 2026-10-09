<!-- P5 (docs/STUDIO-V1-PLAN.md) — design-only mode banner (iPhone/iPad, any browser without Web
     Serial / WebUSB): explains that printing happens from a computer and offers "Send to
     computer" (studio.openDialog('handoff')). Mounted by App.svelte when studio.designOnly. -->
<script lang="ts">
  import Icon from '../common/Icon.svelte'
  import { getStudio } from '../state/studio.svelte'
  import { designOnlyMessage } from './handoff'

  const studio = getStudio()
  const message = designOnlyMessage(studio.support, navigator)
</script>

<!-- `banner`: App.svelte orders banners above the preview on phones. -->
<div class="notice banner design-only" role="status">
  <span class="glyph"><Icon name="smartphone" size={18} /></span>
  <p class="text">{message}</p>
  <button type="button" class="btn small" onclick={() => studio.openDialog('handoff')}><Icon name="send" size={14} />Send to computer…</button>
</div>

<style>
  .notice {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4);
    border-radius: var(--radius-m);
    background: var(--accent-soft);
    color: var(--text);
  }
  .glyph {
    display: flex;
    color: var(--accent);
  }
  .text {
    flex: 1 1 220px;
    margin: 0;
    min-width: 0;
  }
  .btn {
    margin-left: auto;
  }
</style>
