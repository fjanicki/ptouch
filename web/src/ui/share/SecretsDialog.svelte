<!-- P3 (docs/STUDIO-V1-PLAN.md) — asked before a share link / export when the label holds a
     Wi-Fi password: "Include Wi-Fi password" (unticked every time it opens), then runs
     studio.pendingShare ('link' → copyShareLink, 'file' → exportFile) with
     { includeWifiPasswords }. Open while studio.dialog === 'share-secrets'. -->
<script lang="ts">
  import Modal from '../common/Modal.svelte'
  import { getStudio } from '../state/studio.svelte'

  const studio = getStudio()
  const id = $props.id()
  const open = $derived(studio.dialog === 'share-secrets')
  let include = $state(false)

  // Never remember the choice: every share starts without the password.
  $effect(() => {
    if (open) include = false
  })

  const what = $derived(studio.pendingShare === 'file' ? 'file' : 'link')

  function run() {
    const kind = studio.pendingShare
    const includeWifiPasswords = include
    studio.closeDialog()
    if (kind === 'link') void studio.copyShareLink({ includeWifiPasswords })
    else if (kind === 'file') void studio.exportFile({ includeWifiPasswords })
  }
</script>

<Modal {open} title="Share without the Wi-Fi password?" onclose={() => studio.closeDialog()}>
  <div class="body">
    <p>This label contains a Wi-Fi password. Links and files are easily forwarded, so the password is left out: the shared copy shows the network name, and the recipient types the password in.</p>
    <label class="check" for="{id}-include">
      <input id="{id}-include" type="checkbox" bind:checked={include} aria-describedby={include ? `${id}-warn` : undefined} />
      <span>Include Wi-Fi password</span>
    </label>
    {#if include}
      <p class="warn" id="{id}-warn" role="alert">Anyone with the {what} can read the password and join your network.</p>
    {/if}
  </div>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => studio.closeDialog()}>Cancel</button>
    <button type="button" class="btn primary" onclick={run}>{include ? 'Continue with password' : 'Continue without password'}</button>
  {/snippet}
</Modal>

<style>
  .body {
    display: grid;
    gap: var(--space-3);
  }
  .body p {
    margin: 0;
  }
  .check {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 44px;
    cursor: pointer;
    font-weight: 600;
  }
  .check input {
    width: 20px;
    height: 20px;
    margin: 0;
  }
  .warn {
    padding: var(--space-2);
    border: 1px solid var(--warn);
    border-radius: var(--radius-s);
    color: var(--text);
    background: var(--surface-2);
  }
</style>
