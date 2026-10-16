<!-- Printer models (docs/MODELS-PLAN.md §3.7; P-core-ui) — a real printer of a model nobody has
     tested with the studio is connected (studio.untestedModel): a short, dismissible note with
     Diagnostics and a prefilled GitHub issue (model and connection kind only, never the printer's
     name or address). Dismissing is remembered per model (prefs.dismissedUntested). Loaded on
     demand by MediaBar: most visits never see it (entry-chunk budget). -->
<script lang="ts">
  import Icon from '../common/Icon.svelte'
  import { getStudio } from '../state/studio.svelte'
  import { transportKindLabel } from '../state/view-model'
  import { untestedIssueUrl, untestedModelText } from '../connect/copy'

  let { model, ondismiss }: { model: string; ondismiss?: () => void } = $props()

  const studio = getStudio()
  const issueUrl = $derived(untestedIssueUrl(model, transportKindLabel(studio.conn.transport?.kind)))
</script>

<div class="untested" role="status" aria-label="Untested printer model">
  <Icon name="info" size={18} />
  <p>{untestedModelText(model)}</p>
  <div class="actions">
    <button type="button" class="btn small" onclick={() => studio.setView('diagnostics')}><Icon name="activity" size={14} />Open Diagnostics</button>
    <a class="btn small" href={issueUrl} target="_blank" rel="noopener noreferrer">Report an issue</a>
    <button type="button" class="btn small ghost" onclick={() => (studio.dismissUntestedModel(), ondismiss?.())}>Dismiss</button>
  </div>
</div>

<style>
  .untested {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4);
    border-radius: var(--radius-m);
    background: var(--accent-soft);
    color: var(--text);
  }
  .untested > :global(svg) {
    color: var(--accent);
  }
  p {
    flex: 1 1 220px;
    margin: 0;
    min-width: 0;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
</style>
