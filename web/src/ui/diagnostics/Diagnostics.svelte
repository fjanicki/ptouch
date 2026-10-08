<!-- W5 — Diagnostics page (Advanced; ARCHITECTURE.md §6.2/§11 Phase 0): environment + support
     matrix, studio connection (connect by each path, status), raw link probe per path with
     open/close stress (probe.ts), live hex packet log, virtual printer (render → encode →
     download .bin → decode → decoded pages as PNG/PBM), orientation + ruler test labels, and
     "Copy diagnostics" (report.ts, device names masked). -->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { getStudio } from '../state/studio.svelte'
  import ProblemBanner from '../common/ProblemBanner.svelte'
  import { TAPE_WIDTHS_MM, type LabelDoc, type TapeWidthMm } from '../../doc/schema'
  import { openLabelStore } from '../../doc/persist'
  import { downloadBytes } from '../../doc/persist-files'
  import {
    MockTransport,
    WebSerialTransport,
    WebUsbTransport,
    describeProblem,
    isUserCancel,
    toHex,
    type ConnectPath,
    type OpenProgress,
    type PacketLogEntry,
    type ProblemAction,
    type Transport,
  } from '../../printer'
  import { buildPrintJob, canvasReadbackIsNoisy, paintPreview } from '../../render'
  import { isWasmLoaded, version } from '../../wasm'
  import { probeTransport, type ProbeResult, type ProbeStep } from './probe'
  import { buildReport, formatLogEntry, maskText } from './report'
  import { orientationDoc, rulerDoc, type TestLabelKind } from './testlabels'
  import { DEFAULT_MODEL, bitmapPng, freeRun, resolveTarget, runFileBase, runVirtual, type VirtualRun } from './virtual'

  let { onclose }: { onclose: () => void } = $props()
  const studio = getStudio()
  const store = openLabelStore()

  const PATH_LABELS: Record<ConnectPath, string> = {
    bluetooth: 'Bluetooth',
    'serial-port': 'Choose port…',
    usb: 'USB cable',
    virtual: 'Virtual printer',
  }
  const PATH_HINTS: Record<ConnectPath, string> = {
    bluetooth: 'Paired printer, direct RFCOMM (SPP filter)',
    'serial-port': 'Unfiltered chooser: cu.* / COMn / rfcomm ports',
    usb: 'WebUSB, Brother vendor id',
    virtual: 'wasm VirtualPrinter, no hardware',
  }

  // ---- environment ---------------------------------------------------------------------
  let facts = $state<Record<string, string>>({})
  const wasmVersion = $derived(studio.wasm === 'ready' && isWasmLoaded() ? safe(() => version()) : undefined)
  const baseUrl = typeof location !== 'undefined' ? location.origin + import.meta.env.BASE_URL : ''

  function safe<T>(fn: () => T): T | undefined {
    try {
      return fn()
    } catch {
      return undefined
    }
  }

  async function gatherFacts(): Promise<void> {
    const f: Record<string, string> = {}
    f['service worker'] = !('serviceWorker' in navigator) ? 'not supported' : navigator.serviceWorker.controller ? 'active (offline ready)' : 'not controlling this page'
    try {
      f['storage'] = navigator.storage?.persisted ? ((await navigator.storage.persisted()) ? 'persistent' : 'best-effort') : 'n/a'
    } catch {
      f['storage'] = 'n/a'
    }
    const noisy = safe(() => canvasReadbackIsNoisy())
    f['canvas readback'] = noisy === undefined ? 'unknown' : noisy ? 'NOISY (anti-fingerprinting): printing blocked' : 'clean'
    f['secure context'] = String(globalThis.isSecureContext)
    f['standalone'] = String(matchMedia?.('(display-mode: standalone)').matches ?? false)
    facts = f
  }

  // ---- studio connection ---------------------------------------------------------------
  const conn = $derived(studio.conn)
  const studioBusy = $derived(conn.state !== 'disconnected' && conn.state !== 'lost' && conn.state !== 'error')
  const statusHex = $derived(conn.status ? toHex(Uint8Array.from(conn.status.raw)) : '')

  function connectStudio(path: ConnectPath): void {
    // Must stay synchronous up to requestPort()/requestDevice() (user gesture).
    void studio.connection.connect(path)
  }

  function onProblemAction(a: ProblemAction): void {
    if (a === 'choose-port') connectStudio('serial-port')
    else if (a === 'connect-bluetooth') connectStudio('bluetooth')
    else if (a === 'connect-usb') connectStudio('usb')
    else if (a === 'retry' || a === 'reconnect') void studio.connection.reconnect()
    else studio.connection.dismissProblem()
  }

  // ---- raw probe -----------------------------------------------------------------------
  let cycles = $state(3)
  let probing = $state<ConnectPath | null>(null)
  let probeSteps = $state<ProbeStep[]>([])
  let probeProgress = $state<OpenProgress | null>(null)
  let probeMessage = $state('')
  let probeController: AbortController | null = null
  let probeHistory = $state.raw<{ path: string; result: ProbeResult }[]>([])

  function requestTransport(path: ConnectPath): Promise<Transport> {
    switch (path) {
      case 'bluetooth':
        return WebSerialTransport.requestBluetooth()
      case 'serial-port':
        return WebSerialTransport.requestAnyPort()
      case 'usb':
        return WebUsbTransport.request()
      case 'virtual':
        return Promise.resolve(new MockTransport())
    }
  }

  /** Frees what a probe transport owns beyond close() (the mock's VirtualPrinter). */
  async function disposeTransport(t: Transport | null): Promise<void> {
    if (t instanceof MockTransport) await t.dispose()
  }

  function startProbe(path: ConnectPath): void {
    if (probing) return
    if (studioBusy) {
      probeMessage = 'Disconnect the studio first: a port can only be opened by one connection at a time.'
      return
    }
    // The chooser must be opened synchronously inside this click handler.
    const pending = requestTransport(path)
    probing = path
    probeSteps = []
    probeProgress = null
    probeMessage = `Choose the printer in the browser dialog…`
    probeController = new AbortController()
    void runProbe(path, pending, probeController.signal)
  }

  async function runProbe(path: ConnectPath, pending: Promise<Transport>, signal: AbortSignal): Promise<void> {
    let transport: Transport | null = null
    try {
      transport = await pending
      probeMessage = `Probing ${maskText(transport.info.label)} (${transport.info.kind}), ${cycles}×…`
      const result = await probeTransport(transport, cycles, signal, {
        log: studio.connection.packetLog,
        onStep: (_s, all) => (probeSteps = [...all]),
        onOpenProgress: (p) => (probeProgress = p),
      })
      probeHistory = [...probeHistory.slice(-4), { path, result }]
      probeMessage = signal.aborted ? 'Probe cancelled.' : `Done: ${result.replies} of ${result.cycles} status requests answered.`
    } catch (e) {
      if (isUserCancel(e)) probeMessage = 'No device chosen.'
      else {
        const p = describeProblem(e, { support: studio.support, stage: 'open' })
        probeMessage = `${p.title}. ${p.detail}`
      }
    } finally {
      await disposeTransport(transport).catch(() => {})
      probing = null
      probeProgress = null
      probeController = null
    }
  }

  // ---- packet log ----------------------------------------------------------------------
  let logEntries = $state.raw<readonly PacketLogEntry[]>([])
  let logDir = $state<'all' | '>>' | '<<' | '--'>('all')
  let logQuery = $state('')
  let logCopied = $state(false)
  const LOG_VIEW_MAX = 400
  const logLines = $derived.by(() => {
    const q = logQuery.trim().toLowerCase()
    const out: { key: number; dir: string; text: string }[] = []
    for (let i = logEntries.length - 1; i >= 0 && out.length < LOG_VIEW_MAX; i--) {
      const e = logEntries[i]
      if (!e || (logDir !== 'all' && e.dir !== logDir)) continue
      const text = maskText(formatLogEntry(e))
      if (q && !text.toLowerCase().includes(q)) continue
      out.push({ key: i, dir: e.dir, text })
    }
    return out.reverse()
  })

  async function copyLog(): Promise<void> {
    logCopied = await copyText(logLines.map((l) => l.text).join('\n'))
    setTimeout(() => (logCopied = false), 2000)
  }

  // ---- virtual printer + test labels ---------------------------------------------------
  type Source = 'current' | TestLabelKind
  let source = $state<Source>('orientation')
  let widthMm = $state<TapeWidthMm>(24)
  let run = $state.raw<VirtualRun | null>(null)
  let runDoc = $state.raw<LabelDoc | null>(null)
  let running = $state(false)
  let runError = $state('')
  let printing = $state(false)
  let previewCanvas = $state<HTMLCanvasElement | null>(null)
  let decodedCanvas = $state<HTMLCanvasElement | null>(null)
  const model = $derived(conn.model ?? DEFAULT_MODEL)

  function buildSourceDoc(): LabelDoc {
    if (source === 'current') return studio.doc
    const target = resolveTarget(model, widthMm, conn.media)
    if (source === 'orientation') return orientationDoc(widthMm)
    return rulerDoc(widthMm, (target.area.heightDots / target.area.dpi) * 25.4)
  }

  async function renderRun(): Promise<void> {
    if (studio.wasm !== 'ready' || running) return
    running = true
    runError = ''
    try {
      const doc = buildSourceDoc()
      const w = source === 'current' ? doc.tape.widthMm : widthMm
      const target = resolveTarget(model, w, conn.media)
      const next = await runVirtual(doc, target, (ref) => store.getBlob(ref))
      // Unmounted while running: nobody will free `next` later.
      if (destroyed) {
        freeRun(next)
        return
      }
      freeRun(run)
      run = next
      runDoc = doc
    } catch (e) {
      runError = e instanceof Error ? e.message : String(e)
    } finally {
      running = false
    }
  }

  $effect(() => {
    if (run && previewCanvas) paintPreview(previewCanvas, run.render.bitmap, { tape: '#ffffff', ink: '#111111' })
  })
  $effect(() => {
    const page = run?.decoded[0]
    if (page && decodedCanvas) paintPreview(decodedCanvas, page, { tape: '#ffffff', ink: '#111111' })
  })

  function downloadBin(): void {
    if (run && runDoc) downloadBytes(run.bytes, `${runFileBase(runDoc, run.target)}.bin`)
  }
  async function downloadPng(): Promise<void> {
    const page = run?.decoded[0]
    if (run && runDoc && page) downloadBytes(await bitmapPng(page), `${runFileBase(runDoc, run.target)}-decoded.png`, 'image/png')
  }
  function downloadPbm(): void {
    const page = run?.decoded[0]
    if (run && runDoc && page) downloadBytes(page.toPbm(), `${runFileBase(runDoc, run.target)}-decoded.pbm`, 'image/x-portable-bitmap')
  }

  function openInStudio(): void {
    if (!runDoc) return
    studio.setDoc(runDoc)
    onclose()
  }

  async function printRun(): Promise<void> {
    if (!run || !runDoc || conn.state !== 'ready') return
    printing = true
    const job = buildPrintJob(runDoc, run.render, run.target)
    try {
      await studio.connection.print(job)
    } catch (e) {
      runError = e instanceof Error ? e.message : String(e)
    } finally {
      job.free()
      printing = false
    }
  }

  // ---- copy diagnostics ----------------------------------------------------------------
  let reportText = $state('')
  let copyState = $state<'idle' | 'copied' | 'failed'>('idle')

  function makeReport(): string {
    return buildReport(studio.support, studio.conn, studio.connection.packetLog, {
      appVersion: `ptouch studio (${import.meta.env.MODE})`,
      ...(wasmVersion ? { wasmVersion } : {}),
      url: baseUrl,
      facts,
      probes: probeHistory,
    })
  }

  async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  async function copyReport(): Promise<void> {
    reportText = makeReport()
    copyState = (await copyText(reportText)) ? 'copied' : 'failed'
    setTimeout(() => (copyState = 'idle'), 2500)
  }

  let unsubscribeLog: (() => void) | undefined
  let heading: HTMLHeadingElement | undefined = $state()
  onMount(() => {
    void gatherFacts()
    const log = studio.connection.packetLog
    logEntries = [...log.entries()]
    unsubscribeLog = log.subscribe((e) => (logEntries = [...e]))
    const w = conn.media?.widthMm ?? studio.doc.tape.widthMm
    if ((TAPE_WIDTHS_MM as readonly number[]).includes(w)) widthMm = w as TapeWidthMm
    window.scrollTo?.(0, 0)
    // The studio view (and the button that opened this one) is gone: move focus to the heading.
    heading?.focus()
  })
  let destroyed = false
  onDestroy(() => {
    destroyed = true
    unsubscribeLog?.()
    probeController?.abort()
    freeRun(run)
  })

  const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`)
  const yesNo = (v: boolean): string => (v ? 'yes' : 'no')
</script>

<main class="diag" aria-labelledby="diag-title">
  <header class="top">
    <div>
      <h1 id="diag-title" tabindex="-1" bind:this={heading}>Diagnostics</h1>
      <p class="hint">Low-level tools for checking the link to your printer and the print pipeline. Nothing here leaves your browser.</p>
    </div>
    <div class="top-actions">
      <button class="btn primary" onclick={copyReport}>{copyState === 'copied' ? 'Copied ✓' : 'Copy diagnostics'}</button>
      <button class="btn" onclick={onclose}>Back to studio</button>
    </div>
  </header>
  <p class="sr-status" role="status" aria-live="polite">
    {#if copyState === 'copied'}Diagnostics copied to the clipboard. Device names are masked.{:else if copyState === 'failed'}Copying was blocked; select the report below and copy it manually.{/if}
  </p>

  <div class="grid">
    <!-- Environment -->
    <section class="panel card" aria-labelledby="env-h">
      <h2 id="env-h">Environment</h2>
      <dl class="kv">
        <dt>Browser</dt><dd>{studio.support.browser}{studio.support.version ? ` ${studio.support.version}` : ''} · {studio.support.engine} · {studio.support.platform}</dd>
        <dt>Web Serial</dt><dd>{studio.support.serial ? 'available' : 'not available'}</dd>
        <dt>Bluetooth filter</dt><dd>{yesNo(studio.support.bluetoothFilter)}</dd>
        <dt>WebUSB</dt><dd>{studio.support.usb ? (studio.support.usbHidden ? 'available, hidden on Windows' : 'available') : 'not available'}</dd>
        <dt>Brave</dt><dd>{yesNo(studio.support.brave)}</dd>
        <dt>Can print</dt><dd>{yesNo(studio.support.canPrint)}</dd>
        <dt>Connect paths</dt><dd>{studio.support.paths.map((p) => PATH_LABELS[p]).join(', ')}</dd>
        <dt>wasm core</dt><dd>{wasmVersion ?? studio.wasm}</dd>
        {#each Object.entries(facts) as [k, v] (k)}
          <dt>{k[0]?.toUpperCase()}{k.slice(1)}</dt><dd>{v}</dd>
        {/each}
      </dl>
      <details class="ua">
        <summary>User agent</summary>
        <code>{navigator.userAgent}</code>
      </details>
    </section>

    <!-- Studio connection -->
    <section class="panel card" aria-labelledby="conn-h">
      <h2 id="conn-h">Studio connection</h2>
      <dl class="kv">
        <dt>State</dt><dd><span class="pill {conn.state}">{conn.state}</span></dd>
        <dt>Transport</dt><dd>{conn.transport ? `${conn.transport.kind} · ${maskText(conn.transport.label)}` : '—'}</dd>
        <dt>Model</dt><dd>{conn.model ?? '—'}</dd>
        <dt>Media</dt><dd>{conn.media ? `${conn.media.widthMm} mm ${conn.media.kind} (${conn.media.id})` : '—'}</dd>
        {#if conn.status}
          <dt>Tape / ink</dt><dd>{conn.status.tapeColor.name} / {conn.status.textColor.name}</dd>
        {/if}
        {#if conn.openProgress}
          <dt>Opening</dt><dd>Waking printer… attempt {conn.openProgress.attempt} of {conn.openProgress.of}</dd>
        {/if}
      </dl>
      {#if statusHex}
        <p class="field-label">Last status (32 bytes)</p>
        <code class="hex">{statusHex}</code>
      {/if}
      {#if conn.problem}
        <ProblemBanner problem={conn.problem} onaction={onProblemAction} />
      {/if}
      <div class="row">
        {#if studioBusy}
          <button class="btn" onclick={() => void studio.connection.refreshStatus()} disabled={conn.state !== 'ready'}>Request status</button>
          <button class="btn danger" onclick={() => void studio.connection.disconnect()}>Disconnect</button>
        {:else}
          {#each studio.support.paths as p (p)}
            <button class="btn" onclick={() => connectStudio(p)}>{PATH_LABELS[p]}</button>
          {/each}
        {/if}
      </div>
    </section>

    <!-- Raw probe -->
    <section class="panel card wide" aria-labelledby="probe-h">
      <div class="section-head">
        <h2 id="probe-h">Link probe</h2>
        <label class="inline">
          <span>Open/close cycles</span>
          <select class="select narrow" bind:value={cycles} disabled={probing !== null}>
            <option value={1}>1×</option>
            <option value={3}>3×</option>
            <option value={5}>5×</option>
          </select>
        </label>
      </div>
      <p class="hint">
        Opens the port without the print session, sends the status handshake (<code>00×200 1B 40 1B 69 61 01 1B 69 53</code>), times the 32-byte reply and closes
        again. On macOS the first Bluetooth open may fail while the printer wakes up; the probe retries like the studio does.
      </p>
      <div class="paths">
        {#each studio.support.paths as p (p)}
          <button class="btn path" onclick={() => startProbe(p)} disabled={probing !== null || (studioBusy && p !== 'virtual')} aria-describedby="hint-{p}">
            <strong>{PATH_LABELS[p]}</strong>
            <span id="hint-{p}" class="hint">{PATH_HINTS[p]}</span>
          </button>
        {/each}
        {#if probing}
          <button class="btn danger" onclick={() => probeController?.abort()}>Cancel probe</button>
        {/if}
      </div>
      <p class="status-line" role="status" aria-live="polite">
        {#if probeProgress && probeProgress.attempt > 1}Waking printer… attempt {probeProgress.attempt} of {probeProgress.of}.{/if}
        {probeMessage}
      </p>
      {#if probeSteps.length}
        <div class="table-wrap">
          <table>
            <caption class="visually-hidden">Probe steps</caption>
            <thead><tr><th scope="col">Step</th><th scope="col">Result</th><th scope="col" class="num">Time</th><th scope="col">Detail</th></tr></thead>
            <tbody>
              {#each probeSteps as s, i (i)}
                <tr>
                  <td>{s.label}</td>
                  <td><span class="pill {s.ok ? 'ok' : 'fail'}">{s.ok ? 'ok' : 'failed'}</span></td>
                  <td class="num">{fmtMs(s.ms)}</td>
                  <td class="detail">{s.detail ? maskText(s.detail) : ''}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <!-- Packet log -->
    <section class="panel card wide" aria-labelledby="log-h">
      <div class="section-head">
        <h2 id="log-h">Packet log</h2>
        <div class="row">
          <label class="inline">
            <span>Show</span>
            <select class="select narrow" bind:value={logDir}>
              <option value="all">All</option>
              <option value=">>">Sent &gt;&gt;</option>
              <option value="<<">Received &lt;&lt;</option>
              <option value="--">Notes</option>
            </select>
          </label>
          <label class="inline">
            <span class="visually-hidden">Filter log</span>
            <input class="input" type="search" placeholder="Filter (e.g. 1B 69)" bind:value={logQuery} />
          </label>
          <button class="btn" onclick={copyLog} disabled={!logLines.length}>{logCopied ? 'Copied ✓' : 'Copy'}</button>
          <button class="btn" onclick={() => studio.connection.packetLog.clear()} disabled={!logEntries.length}>Clear</button>
        </div>
      </div>
      {#if logLines.length}
        <ol class="log" aria-label="Packet log entries">
          {#each logLines as l (l.key)}
            <li class={l.dir === '>>' ? 'tx' : l.dir === '<<' ? 'rx' : 'note'}>{l.text}</li>
          {/each}
        </ol>
        {#if logEntries.length > LOG_VIEW_MAX}<p class="hint">Showing the newest {LOG_VIEW_MAX} matching entries of {logEntries.length}.</p>{/if}
      {:else}
        <p class="empty">No traffic yet. Connect or run a probe; host → printer lines are marked &gt;&gt;, printer → host &lt;&lt;.</p>
      {/if}
    </section>

    <!-- Virtual printer -->
    <section class="panel card wide" aria-labelledby="virt-h">
      <h2 id="virt-h">Virtual printer &amp; test labels</h2>
      <p class="hint">
        Renders a label, encodes the exact print job in the wasm core, then decodes the bytes again as a printer would. Download the job to compare with the CLI
        (<code>ptouch decode</code>) or print the test labels to check orientation and scale.
      </p>
      <div class="row controls">
        <fieldset class="seg">
          <legend class="visually-hidden">Label</legend>
          <label><input type="radio" name="vsrc" value="orientation" bind:group={source} /> Orientation test</label>
          <label><input type="radio" name="vsrc" value="ruler" bind:group={source} /> Ruler test</label>
          <label><input type="radio" name="vsrc" value="current" bind:group={source} /> Current label</label>
        </fieldset>
        <label class="inline">
          <span>Tape</span>
          <select class="select narrow" bind:value={widthMm} disabled={source === 'current'}>
            {#each TAPE_WIDTHS_MM as w (w)}<option value={w}>{w} mm</option>{/each}
          </select>
        </label>
        <button class="btn primary" onclick={renderRun} disabled={running || studio.wasm !== 'ready'}>{running ? 'Encoding…' : 'Render & encode'}</button>
      </div>
      {#if studio.wasm !== 'ready'}<p class="hint warn">The wasm core is {studio.wasm}.</p>{/if}
      {#if runError}<p class="hint error" role="alert">{runError}</p>{/if}

      {#if run}
        <dl class="kv stats">
          <dt>Target</dt><dd>{run.target.model} · {run.target.media.id} · {run.target.area.heightDots} pins @ {run.target.area.dpi} dpi</dd>
          <dt>Label</dt><dd>{run.render.lengthDots} × {run.render.heightDots} dots ({run.render.lengthMm.toFixed(1)} mm)</dd>
          <dt>Job</dt><dd>{run.bytes.length.toLocaleString()} bytes · {run.pageCount} page(s) · {run.totalLines} raster lines</dd>
          <dt>Decoder</dt><dd>{run.violations.length ? `${run.violations.length} protocol violation(s)` : 'no protocol violations'}</dd>
          {#if run.render.warnings.length}
            <dt>Warnings</dt><dd>{run.render.warnings.map((w) => w.message).join(' · ')}</dd>
          {/if}
        </dl>
        <div class="compare">
          <figure>
            <figcaption>Rendered (preview)</figcaption>
            <div class="tape"><canvas bind:this={previewCanvas} aria-label="Rendered label bitmap"></canvas></div>
          </figure>
          <figure>
            <figcaption>Decoded from the job bytes (page 1 of {run.decoded.length})</figcaption>
            <div class="tape"><canvas bind:this={decodedCanvas} aria-label="Bitmap decoded from the print job"></canvas></div>
          </figure>
        </div>
        <div class="row">
          <button class="btn" onclick={downloadBin}>Download job .bin</button>
          <button class="btn" onclick={downloadPng} disabled={!run.decoded.length}>Decoded page PNG</button>
          <button class="btn" onclick={downloadPbm} disabled={!run.decoded.length}>Decoded page PBM</button>
          {#if source !== 'current'}<button class="btn" onclick={openInStudio}>Open in studio</button>{/if}
          <button class="btn primary" onclick={printRun} disabled={conn.state !== 'ready' || printing || run.render.blocking} title={conn.state !== 'ready' ? 'Connect a printer first' : undefined}>
            {printing ? 'Printing…' : 'Print on printer'}
          </button>
        </div>
        {#if run.violations.length}
          <ul class="violations">{#each run.violations as v, i (i)}<li>{v}</li>{/each}</ul>
        {/if}
        <details>
          <summary>Decoded commands ({run.commands.length})</summary>
          <ol class="log commands">{#each run.commands.slice(0, 300) as c, i (i)}<li>{c}</li>{/each}</ol>
        </details>
      {/if}
    </section>

    <!-- Report -->
    <section class="panel card wide" aria-labelledby="report-h">
      <div class="section-head">
        <h2 id="report-h">Report</h2>
        <button class="btn" onclick={() => (reportText = makeReport())}>{reportText ? 'Refresh' : 'Show report'}</button>
      </div>
      <p class="hint">What “Copy diagnostics” puts on the clipboard. Printer name suffixes and Bluetooth addresses are replaced with x’s.</p>
      {#if reportText}
        <label class="visually-hidden" for="report-text">Diagnostics report</label>
        <textarea id="report-text" class="textarea report" readonly rows="14" value={reportText}></textarea>
      {/if}
    </section>
  </div>
  <footer class="licences">
    ptouch studio is open source (MIT OR Apache-2.0). <a href={`${import.meta.env.BASE_URL}licenses/`} target="_blank" rel="noopener">Third-party licences</a>
  </footer>
</main>

<style>
  .diag {
    max-width: 1120px;
    margin: 0 auto;
    padding: var(--space-5) var(--space-4) var(--space-6);
  }
  .top {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }
  .top h1 {
    margin: 0 0 var(--space-1);
    font-size: 24px;
  }
  .top-actions,
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }
  .sr-status:empty {
    display: none;
  }
  .sr-status {
    margin: 0 0 var(--space-3);
    color: var(--ok);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-4);
  }
  .wide {
    grid-column: 1 / -1;
  }
  .card {
    padding: var(--space-4);
    display: grid;
    gap: var(--space-3);
    align-content: start;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: 16px;
  }
  .section-head {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
  }
  .kv {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--space-1) var(--space-4);
    margin: 0;
  }
  .kv dt {
    color: var(--text-muted);
  }
  .kv dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .ua code,
  .hex {
    display: block;
    font: 12px/1.5 var(--font-mono);
    overflow-wrap: anywhere;
    color: var(--text-muted);
  }
  .hex {
    padding: var(--space-2);
    border-radius: var(--radius-s);
    background: var(--surface-2);
    color: var(--text);
  }
  .field-label {
    margin: 0;
  }
  .pill {
    display: inline-block;
    padding: 0 var(--space-2);
    border-radius: 999px;
    background: var(--surface-2);
    font-size: 12px;
    font-weight: 600;
  }
  .pill.ready,
  .pill.ok {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .pill.error,
  .pill.lost,
  .pill.fail,
  .pill.no-reply {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .pill.opening,
  .pill.waking,
  .pill.handshaking,
  .pill.printing {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .inline {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-muted);
  }
  .narrow {
    width: auto;
    min-width: 88px;
  }
  .paths {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: var(--space-2);
  }
  .btn.path {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: var(--space-2) var(--space-3);
    white-space: normal;
    text-align: left;
  }
  .status-line {
    margin: 0;
    min-height: 1.45em;
  }
  .table-wrap {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th,
  td {
    padding: var(--space-1) var(--space-2);
    border-bottom: 1px solid var(--border);
    text-align: left;
    vertical-align: top;
  }
  th {
    color: var(--text-muted);
    font-weight: 600;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .detail {
    overflow-wrap: anywhere;
  }
  .log {
    margin: 0;
    padding: var(--space-2);
    max-height: 320px;
    overflow: auto;
    list-style: none;
    border-radius: var(--radius-s);
    background: var(--surface-2);
    font: 12px/1.55 var(--font-mono);
  }
  .log li {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .log .tx {
    color: var(--accent);
  }
  .log .rx {
    color: var(--ok);
  }
  .log .note {
    color: var(--text-muted);
  }
  .commands {
    margin-top: var(--space-2);
    color: var(--text);
  }
  .empty {
    margin: 0;
    color: var(--text-muted);
  }
  .controls {
    gap: var(--space-3);
  }
  .seg {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    margin: 0;
    padding: 0;
    border: 0;
  }
  .seg label {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
  }
  .stats {
    font-size: 13px;
  }
  .compare {
    display: grid;
    gap: var(--space-3);
  }
  figure {
    margin: 0;
    display: grid;
    gap: var(--space-1);
    min-width: 0;
  }
  figcaption {
    font-size: 12px;
    color: var(--text-muted);
  }
  .tape {
    padding: var(--space-3);
    border-radius: var(--radius-m);
    background: var(--canvas-bg);
    overflow-x: auto;
  }
  .tape canvas {
    display: block;
    height: 96px;
    width: auto;
    max-width: none;
    image-rendering: pixelated;
    box-shadow: var(--shadow-tape);
    background: #fff;
  }
  .violations {
    margin: 0;
    color: var(--danger);
  }
  .report {
    font: 12px/1.5 var(--font-mono);
    min-height: 240px;
  }
  summary {
    cursor: pointer;
    color: var(--text-muted);
  }
  @media (max-width: 760px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
    .diag {
      padding: var(--space-4) var(--space-3) var(--space-6);
    }
  }
  .licences {
    margin-top: var(--space-5);
    color: var(--text-muted);
    font-size: 13px;
  }
  /* Focused programmatically on open (screen-reader position); not an interactive control. */
  #diag-title:focus {
    outline: none;
  }
</style>
