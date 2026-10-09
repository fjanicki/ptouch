<!-- Properties of a code block: QR / DataMatrix / Code 128 / EAN-13, a Wi-Fi network builder for
     QR codes (password kept on this device), quiet-zone modes and automatic module size with the
     resulting physical size and a readability hint. Codes are encoded in wasm (render/codes.ts);
     this editor only validates input shape for friendly hints. -->
<script lang="ts">
  import { createWifi, type CodeItem, type ModuleSize, type QrEcc, type QuietZone, type Symbology, type WifiSecurity, type WifiSettings } from '../../../doc/schema'
  import { resolveDoc } from '../../../doc/variables'
  import { codeMatrix, dotsToMm, isLinear, itemSizingBand, quietModules } from '../../../render'
  import { chooseModuleDots, readability } from '../../../render/codes'
  import { wifiPayload, wifiWarnings } from '../../../render/wifi'
  import Icon from '../../common/Icon.svelte'
  import NumberField from '../../common/NumberField.svelte'
  import Segmented from '../../common/Segmented.svelte'
  import Switch from '../../common/Switch.svelte'
  import { getStudio } from '../../state/studio.svelte'
  import VariableHint from '../../batch/VariableHint.svelte'

  let { item }: { item: CodeItem } = $props()
  const studio = getStudio()
  const id = $props.id()
  const set = (patch: Partial<Omit<CodeItem, 'id' | 'kind'>>, key?: string) => studio.updateItem<CodeItem>(item.id, patch, key ? `${item.id}:${key}` : undefined)

  const isWifi = $derived(item.symbology === 'qr' && item.content === 'wifi')
  const wifi = $derived<WifiSettings>(item.wifi ?? createWifi())
  const setWifi = (patch: Partial<WifiSettings>, key?: string) => set({ wifi: { ...wifi, ...patch } }, key)
  let showPassword = $state(false)

  const dpi = $derived(studio.target.ok ? studio.target.target.area.dpi : 180)
  // The renderer's own rule (render/renderer.ts itemSizingBand): the band inside a label frame,
  // and the unprinted tape counts as quiet zone only when no frame line borders the band.
  const sizingBand = $derived(studio.target.ok ? itemSizingBand(studio.doc, item, studio.target.target.area) : { bandDots: 128, marginDots: 0, framed: false })
  const band = $derived(sizingBand.bandDots)
  const framed = $derived(sizingBand.framed)
  const marginDots = $derived(sizingBand.marginDots)

  // The code as printed for the preview row ({{variables}} filled in).
  const printed = $derived.by((): CodeItem => {
    const r = resolveDoc(studio.doc, studio.previewRow, { now: new Date() }).doc.items.find((i) => i.id === item.id)
    return r?.kind === 'code' ? r : item
  })
  const encoded = $derived.by((): { m: ReturnType<typeof codeMatrix> } | { error: string } | null => {
    if (studio.wasm !== 'ready') return null
    if (printed.content !== 'wifi' && !printed.data) return null
    try {
      return { m: codeMatrix(printed) }
    } catch (e) {
      return { error: (e instanceof Error ? e.message : String(e)).replace(/^[A-Z_]+:\s*/, '') }
    }
  })
  const matrix = $derived(encoded && 'm' in encoded ? encoded.m : null)

  /** Module size the renderer uses: read back from the rendered box when it matches, else the
   * same rule (chooseModuleDots); a linear 'auto' code on a fixed-length label needs the box. */
  const sizing = $derived.by(() => {
    if (!matrix) return null
    const [qx, qy] = quietModules(matrix, item.quietZone, item.symbology)
    const choice = chooseModuleDots(matrix, { moduleDots: item.moduleDots, quietZone: item.quietZone, symbology: item.symbology, bandDots: band, marginDots })
    let md = choice.md
    const box = studio.render?.boxes.find((b) => b.itemId === item.id)
    const unit = matrix.width + 2 * qx
    if (box && !framed && box.w % unit === 0 && box.w / unit >= 1) md = box.w / unit
    return { md, qx, qy, max: choice.max, linear: isLinear(matrix) }
  })
  const mm = (dots: number): string => dotsToMm(dots, dpi).toFixed(1)
  const sizeText = $derived.by(() => {
    if (!matrix || !sizing) return ''
    const { md, max, linear, qx } = sizing
    if (!linear && max < 1) return 'This code does not fit this tape. Use wider tape or less data.'
    if (linear) return `${md} dot${md === 1 ? '' : 's'} per bar module · about ${mm((matrix.width + 2 * qx) * md)} mm long with its quiet zone.`
    return `${md} dot${md === 1 ? '' : 's'} per module · ${mm(matrix.width * md)} × ${mm(matrix.height * md)} mm (${matrix.width} × ${matrix.height} modules).`
  })
  const read = $derived(sizing && !(sizing.max < 1 && !sizing.linear) ? readability(sizing.md) : null)

  const wifiProblem = $derived.by((): { text: string; tone: '' | 'warn' | 'error' } => {
    if (!isWifi) return { text: '', tone: '' }
    const w = printed.wifi ?? createWifi()
    try {
      wifiPayload(w)
    } catch (e) {
      return { text: e instanceof Error ? e.message : String(e), tone: 'error' }
    }
    const warn = wifiWarnings(w)[0]
    if (warn) return { text: warn, tone: 'warn' }
    return { text: 'iPhone and Android cameras offer to join this network.', tone: '' }
  })

  const dataHint = $derived.by((): { text: string; tone: '' | 'error' } => {
    const d = item.data
    if (item.symbology === 'ean13') {
      if (!/^\d*$/.test(d)) return { text: 'EAN-13 takes digits only.', tone: 'error' }
      if (d.length !== 12 && d.length !== 13) return { text: `Enter 12 digits (the check digit is added) or 13. Now: ${d.length}.`, tone: 'error' }
      return { text: d.length === 12 ? 'The check digit is added automatically.' : '13 digits including the check digit.', tone: '' }
    }
    if (item.symbology === 'code128') {
      // eslint-disable-next-line no-control-regex
      if (!/^[\x00-\x7f]*$/.test(d)) return { text: 'Code 128 supports plain ASCII characters only.', tone: 'error' }
      return { text: 'Letters, digits and symbols. Short is better on narrow tape.', tone: '' }
    }
    if (encoded && 'error' in encoded) return { text: encoded.error, tone: 'error' }
    const bytes = new TextEncoder().encode(d).length
    if (item.symbology === 'datamatrix') return { text: `${bytes} bytes. Plain letters and digits scan most reliably.`, tone: '' }
    return { text: `${bytes} bytes. URLs and plain text both work.`, tone: '' }
  })

  const SYMBOLOGY_HINT: Record<Symbology, string> = {
    qr: 'QR: best for phone cameras (the iPhone Camera app reads it).',
    datamatrix: 'DataMatrix: smaller, but needs a scanner app. Phone cameras usually ignore it.',
    code128: 'Code 128: a barcode for handheld scanners and inventory apps.',
    ean13: 'EAN-13: retail product numbers (12 or 13 digits).',
  }

  function setSymbology(symbology: Symbology) {
    if (symbology === item.symbology) return
    const linear = symbology === 'code128' || symbology === 'ean13'
    const patch: Partial<CodeItem> = { symbology, showText: linear }
    if (symbology === 'ean13' && !/^\d{12,13}$/.test(item.data)) patch.data = '400638133393'
    if (symbology !== 'qr' && item.content === 'wifi') patch.content = 'text'
    if (linear && typeof item.moduleDots === 'number' && item.moduleDots > 3) patch.moduleDots = 2
    set(patch)
  }
  function setContent(content: 'text' | 'wifi') {
    if (content === item.content) return
    set(content === 'wifi' ? { content, wifi: item.wifi ?? createWifi() } : { content })
  }
  function setModuleMode(mode: 'auto' | 'fixed') {
    if (mode === 'auto') set({ moduleDots: 'auto' })
    else if (item.moduleDots === 'auto') set({ moduleDots: Math.max(1, Math.min(20, sizing?.md ?? 2)) })
  }
  const moduleMode = $derived<'auto' | 'fixed'>(item.moduleDots === 'auto' ? 'auto' : 'fixed')
  const fixedDots = $derived(typeof item.moduleDots === 'number' ? item.moduleDots : (sizing?.md ?? 2))
  const fixedHint = $derived.by(() => {
    if (moduleMode !== 'fixed' || !sizing || sizing.linear) return 'Wider modules scan more reliably.'
    if (sizing.max >= 1 && fixedDots > sizing.max) return `Only ${sizing.max} fit${sizing.max === 1 ? 's' : ''} this tape, so it prints at ${sizing.max}.`
    return `Up to ${Math.max(0, sizing.max)} fit this tape.`
  })

  const quietHint = $derived.by((): string => {
    const linear = item.symbology === 'code128' || item.symbology === 'ean13'
    const dm = item.symbology === 'datamatrix'
    switch (item.quietZone) {
      case 'standard':
        if (linear) return '10 modules of blank space left and right (the standard).'
        return dm ? '1 module of blank space all round (the DataMatrix standard).' : '4 modules of blank space all round (the QR standard). The unprinted tape edge counts above and below.'
      case 'compact':
        if (linear) return '5 modules left and right. Most scanners still read it.'
        return dm
          ? 'The code may fill the tape height; the unprinted tape edge is its margin. 1 module left and right.'
          : 'The code may fill the tape height; the unprinted tape edge is its margin. 2 modules left and right, half the QR standard of 4: keep other ink at least that far away. Most phones still read it.'
      case 'none':
        return 'No blank margin. Keep other ink away from the code, or it may not scan.'
    }
  })

  const ECC: { value: QrEcc; label: string }[] = [
    { value: 'L', label: 'Low (7 %)' },
    { value: 'M', label: 'Medium (15 %)' },
    { value: 'Q', label: 'Quartile (25 %)' },
    { value: 'H', label: 'High (30 %)' },
  ]
  const QUIET: { value: QuietZone; label: string }[] = [
    { value: 'standard', label: 'Standard' },
    { value: 'compact', label: 'Compact' },
    { value: 'none', label: 'None' },
  ]
  const SECURITY: { value: WifiSecurity; label: string }[] = [
    { value: 'wpa', label: 'WPA / WPA2 / WPA3' },
    { value: 'wep', label: 'WEP (old)' },
    { value: 'open', label: 'None (open network)' },
  ]
</script>

<div class="field code-type">
  <Segmented
    label="Code type"
    size="small"
    options={[
      { value: 'qr', label: 'QR' },
      { value: 'datamatrix', label: 'DataMatrix' },
      { value: 'code128', label: 'Code 128' },
      { value: 'ean13', label: 'EAN-13' },
    ]}
    value={item.symbology}
    onchange={setSymbology}
  />
  <p class="hint">{SYMBOLOGY_HINT[item.symbology]}</p>
</div>

{#if item.symbology === 'qr'}
  <Segmented
    label="What to encode"
    options={[
      { value: 'text', label: 'Text or link' },
      { value: 'wifi', label: 'Wi-Fi network', icon: 'wifi' },
    ]}
    value={item.content}
    onchange={setContent}
  />
{/if}

{#if isWifi}
  <div class="field">
    <label class="field-label" for="{id}-ssid">Network name (SSID)</label>
    <input id="{id}-ssid" class="input" value={wifi.ssid} maxlength={64} autocomplete="off" spellcheck="false" aria-describedby="{id}-wifi-hint" oninput={(e) => setWifi({ ssid: e.currentTarget.value }, 'ssid')} />
    <VariableHint text={wifi.ssid} />
  </div>
  <div class="field">
    <label class="field-label" for="{id}-security">Security</label>
    <select id="{id}-security" class="select" value={wifi.security} onchange={(e) => setWifi({ security: e.currentTarget.value as WifiSecurity })}>
      {#each SECURITY as s (s.value)}<option value={s.value}>{s.label}</option>{/each}
    </select>
  </div>
  {#if wifi.security !== 'open'}
    <div class="field">
      <label class="field-label" for="{id}-password">Password</label>
      <div class="password">
        <input
          id="{id}-password"
          class="input"
          type={showPassword ? 'text' : 'password'}
          value={wifi.password}
          maxlength={64}
          autocomplete="off"
          spellcheck="false"
          aria-describedby="{id}-password-note"
          oninput={(e) => setWifi({ password: e.currentTarget.value }, 'password')}
        />
        <button type="button" class="btn icon" aria-label="Show password" aria-pressed={showPassword} title={showPassword ? 'Hide password' : 'Show password'} onclick={() => (showPassword = !showPassword)}>
          <Icon name={showPassword ? 'eye-off' : 'eye'} />
        </button>
      </div>
      <p class="hint" id="{id}-password-note">The password stays on this device. Share links and exported files leave it out unless you choose to include it.</p>
    </div>
  {/if}
  <Switch label="Hidden network" hint="The network does not broadcast its name" checked={wifi.hidden} onchange={(hidden) => setWifi({ hidden })} />
  <p class="hint {wifiProblem.tone}" id="{id}-wifi-hint" aria-live="polite">{wifiProblem.text}</p>
  <button type="button" class="btn small add-ssid" onclick={() => studio.insert('text', { text: '{{ssid}}' })}>
    <Icon name="type" size={16} />
    Add network name label
  </button>
{:else}
  <div class="field">
    <label class="field-label" for="{id}-data">{item.symbology === 'qr' || item.symbology === 'datamatrix' ? 'Content' : 'Data'}</label>
    {#if item.symbology === 'qr' || item.symbology === 'datamatrix'}
      <textarea id="{id}-data" class="textarea" rows="2" value={item.data} aria-describedby="{id}-data-hint" aria-invalid={dataHint.tone === 'error'} oninput={(e) => set({ data: e.currentTarget.value }, 'data')}></textarea>
    {:else}
      <input
        id="{id}-data"
        class="input"
        value={item.data}
        inputmode={item.symbology === 'ean13' ? 'numeric' : 'text'}
        aria-describedby="{id}-data-hint"
        aria-invalid={dataHint.tone === 'error'}
        oninput={(e) => set({ data: e.currentTarget.value }, 'data')}
      />
    {/if}
    <p class="hint {dataHint.tone}" id="{id}-data-hint">{dataHint.text}</p>
    <VariableHint text={item.data} />
  </div>
{/if}

<div class="field">
  <Segmented
    label="Quiet zone"
    options={QUIET}
    value={item.quietZone}
    onchange={(quietZone) => set({ quietZone })}
  />
  <p class="hint">{quietHint}</p>
</div>

<div class="field">
  <Segmented
    label="Module size"
    options={[
      { value: 'auto', label: 'Auto' },
      { value: 'fixed', label: 'Fixed' },
    ]}
    value={moduleMode}
    onchange={setModuleMode}
  />
  {#if moduleMode === 'auto'}
    <p class="hint">{sizing?.linear ? 'Fills a fixed label length (up to 4 dots), else 2 dots.' : 'The largest size that fits the tape.'}</p>
  {:else}
    <NumberField label="Dots per module" unit="dots" min={1} max={20} step={1} value={fixedDots} onchange={(v) => set({ moduleDots: Math.round(v) as ModuleSize }, 'module')} hint={fixedHint} />
  {/if}
</div>

{#if sizeText}
  <div class="readout" aria-live="polite">
    <p class="size">{sizeText}</p>
    {#if read}<p class="read {read.level}"><strong>{read.level === 'good' ? 'Readability: good.' : read.level === 'ok' ? 'Readability: OK.' : 'Readability: poor.'}</strong> {read.text}</p>{/if}
  </div>
{/if}

{#if item.symbology === 'qr'}
  <div class="field">
    <label class="field-label" for="{id}-ecc">Error correction</label>
    <select id="{id}-ecc" class="select" value={item.ecc} onchange={(e) => set({ ecc: e.currentTarget.value as QrEcc })}>
      {#each ECC as e (e.value)}<option value={e.value}>{e.label}</option>{/each}
    </select>
  </div>
{/if}

{#if item.symbology === 'code128' || item.symbology === 'ean13'}
  <Switch label="Show text" hint="Print the data under the bars" checked={item.showText} onchange={(showText) => set({ showText })} />
{/if}

<style>
  /* Four names in a ~280 px panel: size the options to their text so "DataMatrix" is never cut. */
  .code-type :global(.seg button) {
    flex: 1 1 auto;
    padding: 0 6px;
  }
  .password {
    display: flex;
    gap: var(--space-1);
  }
  .password .input {
    flex: 1 1 auto;
    min-width: 0;
  }
  .password .btn {
    flex: none;
  }
  .add-ssid {
    justify-self: start;
    gap: 6px;
  }
  .readout {
    display: grid;
    gap: 2px;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: var(--surface-2);
    font-size: 12px;
  }
  .readout p {
    margin: 0;
  }
  .read.ok {
    color: var(--warn);
  }
  .read.poor {
    color: var(--danger);
  }
</style>
