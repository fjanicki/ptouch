<!-- P5 (docs/STUDIO-V1-PLAN.md) — "Send to computer": Web Share API (AirDrop / Messages) with the
     share link (studio.createShareUrl), the link with Copy, and the .ptlabel.json export
     (studio.exportFile, or the file through the share sheet). Wi-Fi passwords are left out
     unless "Include Wi-Fi password" is ticked. Open while studio.dialog === 'handoff'.
     The link and the file are built when the dialog opens, so Share runs straight from the tap
     (Safari needs a fresh user gesture). No QR code of the link: computers rarely scan. -->
<script lang="ts">
  import Modal from '../common/Modal.svelte'
  import Icon from '../common/Icon.svelte'
  import { docHasSecrets } from '../../doc/secrets'
  import { errorMessage, getStudio } from '../state/studio.svelte'
  import { canShareFile, canShareLink, fileShareData, handoffCopy, labelShareFile, linkShareData, share } from './handoff'

  const studio = getStudio()
  const id = $props.id()

  const open = $derived(studio.dialog === 'handoff')
  const hasSecrets = $derived(docHasSecrets(studio.doc))
  const designOnly = $derived(studio.designOnly)

  let include = $state(false)
  let link = $state.raw<{ url: string; notices: string[] } | null>(null)
  let linkError = $state<string | null>(null)
  let file = $state.raw<{ file: File; notices: string[] } | null>(null)
  let status = $state('')
  let statusTone = $state<'ok' | 'error'>('ok')
  let linkField: HTMLInputElement | undefined = $state()
  let seq = 0

  const shareLinkOk = $derived(!!link && canShareLink(navigator, link.url))
  const shareFileOk = $derived(!!file && canShareFile(navigator, file.file))
  const copy = $derived(handoffCopy({ designOnly, canShare: shareLinkOk }))
  const notices = $derived([...new Set([...(link?.notices ?? []), ...(file?.notices ?? [])])])

  $effect(() => {
    if (!open) {
      seq++
      include = false
      link = null
      linkError = null
      file = null
      status = ''
      return
    }
    void build(studio.doc, include, ++seq)
  })

  async function build(doc: typeof studio.doc, includeWifiPasswords: boolean, n: number): Promise<void> {
    const opts = { includeWifiPasswords }
    const [l, f] = await Promise.allSettled([studio.createShareUrl(opts), labelShareFile(doc, studio.store, opts)])
    if (n !== seq) return
    link = l.status === 'fulfilled' ? l.value : null
    linkError = l.status === 'rejected' ? errorMessage(l.reason) : null
    file = f.status === 'fulfilled' ? f.value : null
  }

  function say(text: string, tone: 'ok' | 'error' = 'ok') {
    status = text
    statusTone = tone
  }

  async function onShareLink() {
    if (!link) return
    const r = await share(navigator, linkShareData(studio.doc.name, link.url))
    if (r.outcome === 'shared') say('Sent. Open the link on your computer to print.')
    else if (r.outcome === 'failed') say(`Could not share the link: ${errorMessage(r.error)}`, 'error')
  }

  async function onShareFile() {
    if (!file) return
    const r = await share(navigator, fileShareData(studio.doc.name, file.file))
    if (r.outcome === 'shared') say('Sent. Open the file on your computer with Labels → Import file.')
    else if (r.outcome === 'failed') say(`Could not share the file: ${errorMessage(r.error)}`, 'error')
  }

  async function onCopy() {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link.url)
      say('Link copied.')
    } catch {
      linkField?.select()
      say('Could not copy automatically. The link is selected: copy it from the field.', 'error')
    }
  }
</script>

<Modal open={open} title="Send to computer" description={copy.description} onclose={() => studio.closeDialog()}>
  <div class="handoff">
    <ol class="steps" aria-label="How to print from a computer">
      <li>{copy.firstStep}</li>
      <li>On your computer, open the link in <strong>Chrome</strong> or <strong>Edge</strong>. If it opens in Safari, paste the address into Chrome.</li>
      <li>Connect the printer, then <strong>Print</strong>.</li>
    </ol>

    {#if hasSecrets}
      <div class="secret">
        <label class="check">
          <input type="checkbox" bind:checked={include} aria-describedby="{id}-secret-hint" />
          <span>Include Wi-Fi password</span>
        </label>
        <p class="hint" id="{id}-secret-hint">
          {include ? 'Anyone with the link or file can read the password.' : 'The password is left out: type it again on the computer before printing.'}
        </p>
      </div>
    {/if}

    <div class="field">
      <label class="field-label" for="{id}-link">Share link</label>
      <div class="link-row">
        <input
          bind:this={linkField}
          id="{id}-link"
          class="input link"
          readonly
          value={link?.url ?? ''}
          placeholder={linkError ? 'No link for this label' : 'Making the link…'}
          spellcheck="false"
          onfocus={(e) => e.currentTarget.select()}
        />
        <button type="button" class="btn" disabled={!link} onclick={onCopy}><Icon name="copy" size={16} />Copy</button>
      </div>
      {#if linkError}<p class="hint error">{linkError}</p>{/if}
    </div>

    {#if notices.length}
      <ul class="notices">
        {#each notices as n (n)}<li class="hint warn">{n}</li>{/each}
      </ul>
    {/if}

    <p class="status {statusTone}" role="status">{status}</p>
  </div>

  {#snippet footer()}
    <button type="button" class="btn" onclick={() => void studio.exportFile({ includeWifiPasswords: include })}><Icon name="download" size={16} />Export file</button>
    {#if shareFileOk}
      <button type="button" class="btn" onclick={onShareFile}><Icon name="share" size={16} />Share file…</button>
    {/if}
    {#if shareLinkOk}
      <button type="button" class="btn primary" onclick={onShareLink}><Icon name="send" size={16} />Share link…</button>
    {/if}
  {/snippet}
</Modal>

<style>
  .handoff {
    display: grid;
    gap: var(--space-4);
  }
  .steps {
    margin: 0;
    padding-left: 1.4em;
    display: grid;
    gap: var(--space-1);
  }
  .secret {
    display: grid;
    gap: var(--space-1);
    padding: var(--space-3);
    border-radius: var(--radius-m);
    background: var(--warn-soft);
  }
  .check {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 32px;
    font-weight: 600;
    cursor: pointer;
  }
  .check input {
    width: 18px;
    height: 18px;
    margin: 0;
  }
  .link-row {
    display: flex;
    gap: var(--space-2);
    min-width: 0;
  }
  .link {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: 12px;
    text-overflow: ellipsis;
  }
  .notices {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: var(--space-1);
  }
  .status {
    margin: 0;
    min-height: 1.45em;
    font-size: 13px;
    color: var(--ok);
  }
  .status.error {
    color: var(--danger);
  }
  .status:empty {
    min-height: 0;
  }
</style>
