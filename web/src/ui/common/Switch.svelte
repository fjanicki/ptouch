<!-- W4 — on/off switch (a real checkbox with role="switch"). -->
<script lang="ts">
  let { label, checked, onchange, hint, disabled = false }: { label: string; checked: boolean; onchange: (v: boolean) => void; hint?: string; disabled?: boolean } = $props()
  const id = $props.id()
</script>

<div class="switch-wrap">
  <label class="switch" class:disabled for={id}>
    <input {id} type="checkbox" role="switch" {checked} {disabled} aria-describedby={hint ? `${id}-hint` : undefined} onchange={(e) => onchange(e.currentTarget.checked)} />
    <span class="track" aria-hidden="true"><span class="thumb"></span></span>
    <span class="text">{label}</span>
  </label>
  {#if hint}<p class="hint" id="{id}-hint">{hint}</p>{/if}
</div>

<style>
  .switch {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    cursor: pointer;
    min-height: 28px;
    padding-top: 2px;
  }
  .switch.disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  input {
    position: absolute;
    opacity: 0;
    width: 34px;
    height: 20px;
    margin: 0;
  }
  .track {
    flex: none;
    position: relative;
    width: 34px;
    height: 20px;
    border-radius: 999px;
    background: var(--surface-3);
    border: 1px solid var(--control-border);
    transition: background-color 150ms var(--ease);
  }
  .thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--surface);
    box-shadow: var(--shadow-1);
    transition: transform 150ms var(--ease);
  }
  input:checked + .track {
    background: var(--accent);
    border-color: var(--accent);
  }
  input:checked + .track .thumb {
    transform: translateX(14px);
    background: var(--accent-text);
  }
  input:focus-visible + .track {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .text {
    line-height: 1.3;
    padding-top: 1px;
  }
  .switch-wrap .hint {
    padding-left: 42px;
    margin-top: -4px;
  }
</style>
