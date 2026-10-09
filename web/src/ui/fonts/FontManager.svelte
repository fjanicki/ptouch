<!-- P4 (docs/STUDIO-V1-PLAN.md) — custom fonts: upload TTF/OTF/WOFF/WOFF2 (studio.fonts), local
     fonts via queryLocalFonts() where available ("varies by machine"; permission prompt only on
     click); remove. Calls studio.fontsChanged() after a change. Open while
     studio.dialog === 'fonts'. -->
<script lang="ts">
  import { FONT_ACCEPT, MAX_FONT_BYTES, MAX_FONTS, type UserFontInfo } from '../../doc/persist-fonts'
  import { customFamily, forgetCustomFont, loadCustomFont } from '../../render/fonts'
  import Icon from '../common/Icon.svelte'
  import Modal from '../common/Modal.svelte'
  import { errorMessage, getStudio } from '../state/studio.svelte'
  import { localFonts, localFontsSupported } from './local-fonts.svelte'

  const studio = getStudio()
  const open = $derived(studio.dialog === 'fonts')
  let fonts = $state<UserFontInfo[] | null>(null)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let status = $state('')
  let input: HTMLInputElement | undefined = $state()
  /** Refs whose face is loaded for the sample line. */
  let ready = $state<Record<string, boolean>>({})
  const canListLocal = localFontsSupported()

  $effect(() => {
    if (!open) return
    void studio.fontsVersion
    void refresh()
  })

  async function refresh(): Promise<void> {
    try {
      const list = await studio.fonts.list()
      fonts = list
      for (const f of list) {
        if (ready[f.ref]) continue
        void loadCustomFont({ kind: 'user', ref: f.ref, family: f.family }, (r) => studio.fonts.get(r)).then((ok) => {
          if (ok) ready = { ...ready, [f.ref]: true }
        })
      }
    } catch (e) {
      error = errorMessage(e)
      fonts = []
    }
  }

  async function add(files: FileList | null): Promise<void> {
    if (!files?.length) return
    busy = true
    error = null
    const added: string[] = []
    const failed: string[] = []
    for (const file of files) {
      try {
        added.push((await studio.fonts.add(file)).family)
      } catch (e) {
        failed.push(`${file.name}: ${errorMessage(e)}`)
      }
    }
    busy = false
    if (input) input.value = ''
    if (failed.length) error = failed.join(' ')
    if (added.length) {
      status = added.length === 1 ? `Added “${added[0]}”.` : `Added ${added.length} fonts.`
      studio.announce(status)
      studio.fontsChanged()
    }
  }

  async function remove(f: UserFontInfo): Promise<void> {
    if (!confirm(`Remove “${f.family}”? Labels that use it will show the built-in font instead.`)) return
    try {
      await studio.fonts.remove(f.ref)
      forgetCustomFont({ kind: 'user', ref: f.ref, family: f.family })
      status = `Removed “${f.family}”.`
      studio.announce(status)
      studio.fontsChanged()
    } catch (e) {
      error = errorMessage(e)
    }
  }

  const FORMAT: Record<UserFontInfo['format'], string> = { ttf: 'TrueType', otf: 'OpenType', woff: 'WOFF', woff2: 'WOFF2' }
  const kb = (n: number): string => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
</script>

<Modal {open} title="Fonts" description="Use your own fonts in text blocks. They stay in this browser." onclose={() => studio.closeDialog()}>
  <section aria-labelledby="fonts-yours">
    <div class="head">
      <h3 id="fonts-yours">Your fonts</h3>
      <button type="button" class="btn primary" disabled={busy} onclick={() => input?.click()}><Icon name="upload" size={16} />{busy ? 'Adding…' : 'Add font file…'}</button>
      <input bind:this={input} class="visually-hidden" type="file" accept={FONT_ACCEPT} multiple tabindex="-1" aria-label="Font files" onchange={(e) => void add(e.currentTarget.files)} />
    </div>
    <p class="hint">TTF, OTF, WOFF or WOFF2, up to {MAX_FONT_BYTES / 1024 / 1024} MB each and {MAX_FONTS} fonts. Only add fonts you are allowed to use.</p>
    {#if error}<p class="hint error" role="alert">{error}</p>{/if}
    <p class="visually-hidden" role="status">{status}</p>
    {#if fonts === null}
      <p class="empty">Loading…</p>
    {:else if fonts.length === 0}
      <p class="empty">No fonts added yet. Added fonts appear in the Font list of every text block.</p>
    {:else}
      <ul class="list" aria-label="Your fonts">
        {#each fonts as f (f.ref)}
          <li>
            <div class="meta">
              <strong>{f.family}</strong>
              <span>{FORMAT[f.format]} · {kb(f.size)} · {f.fileName}</span>
              <span class="sample" aria-hidden="true" style:font-family={ready[f.ref] ? `"${customFamily({ kind: 'user', ref: f.ref, family: f.family })}", sans-serif` : undefined}>Shelf A-12 0123</span>
            </div>
            <button type="button" class="btn ghost icon small" aria-label="Remove {f.family}" onclick={() => void remove(f)}><Icon name="trash" size={16} /></button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section aria-labelledby="fonts-local">
    <h3 id="fonts-local">On this computer</h3>
    {#if canListLocal}
      <p class="hint">Fonts installed on this computer can be used too. They vary by machine: a label that uses one prints as designed only on a computer that has the font.</p>
      {#if localFonts.status === 'ready'}
        <p class="ok" role="status"><Icon name="check" size={16} />{localFonts.fonts.length === 1 ? '1 font' : `${localFonts.fonts.length} fonts`} available. Pick them in the Font list of a text block, under “This computer”.</p>
      {:else}
        <button type="button" class="btn" disabled={localFonts.status === 'loading'} onclick={() => void localFonts.query()}>
          <Icon name="monitor" size={16} />{localFonts.status === 'loading' ? 'Asking…' : 'Use fonts from this computer…'}
        </button>
        {#if localFonts.error}<p class="hint error" role="alert">{localFonts.error}</p>{/if}
      {/if}
    {:else}
      <p class="hint">This browser cannot list installed fonts (Chrome or Edge on a computer can). Add font files above instead.</p>
    {/if}
  </section>

  <p class="hint note"><Icon name="info" size={14} />Share links and exported labels do not include fonts. Someone without the font sees the built-in font instead.</p>
</Modal>

<style>
  section + section {
    margin-top: var(--space-5);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
  }
  h3 {
    margin: 0;
    font-size: 15px;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }
  #fonts-local {
    margin-bottom: var(--space-2);
  }
  .empty {
    margin: var(--space-3) 0 0;
    color: var(--text-muted);
  }
  .list {
    list-style: none;
    margin: var(--space-3) 0 0;
    padding: 0;
    display: grid;
    gap: var(--space-2);
  }
  li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-m);
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  }
  .meta {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 2px;
  }
  .meta span {
    color: var(--text-muted);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta .sample {
    color: var(--text);
    font-size: 18px;
  }
  .ok {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-2) 0 0;
  }
  .ok :global(svg) {
    flex: none;
    color: var(--ok);
  }
  .note {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
    margin-top: var(--space-4);
  }
  .note :global(svg) {
    flex: none;
    margin-top: 2px;
  }
</style>
