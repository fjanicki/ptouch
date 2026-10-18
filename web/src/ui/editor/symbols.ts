// "Insert special character" (docs/TABLE-PLAN.md §12) — the symbols the menu offers, by group.
// Lazy (SymbolMenu.svelte only). Every symbol is drawn by a bundled font on every device: the
// item's own face when it has the glyph, else JetBrains Mono, else B612 (render/fonts.ts
// `faceCss` / `fontsUsed`). tests/unit/render/symbol-fonts.test.ts checks each one against the
// cmap of every bundled woff2; symbols no bundled font has (♮ ♩ ♪ ♫ ♥ ⌀ ✔ ✘) are left out.

export interface SymbolGroup {
  label: string
  /** [symbol, name] — the name is the button's accessible name and tooltip. */
  symbols: readonly (readonly [string, string])[]
}

export const SYMBOL_GROUPS: readonly SymbolGroup[] = [
  {
    label: 'Music',
    symbols: [
      ['♯', 'Sharp'],
      ['♭', 'Flat'],
    ],
  },
  {
    label: 'Arrows',
    symbols: [
      ['←', 'Left arrow'],
      ['→', 'Right arrow'],
      ['↑', 'Up arrow'],
      ['↓', 'Down arrow'],
      ['↔', 'Left right arrow'],
      ['↕', 'Up down arrow'],
      ['⇐', 'Double left arrow'],
      ['⇒', 'Double right arrow'],
      ['▲', 'Up triangle'],
      ['▼', 'Down triangle'],
      ['◀', 'Left triangle'],
      ['▶', 'Right triangle'],
    ],
  },
  {
    label: 'Maths',
    symbols: [
      ['±', 'Plus minus'],
      ['−', 'Minus'],
      ['×', 'Times'],
      ['÷', 'Divided by'],
      ['≈', 'Approximately'],
      ['≠', 'Not equal'],
      ['≤', 'Less or equal'],
      ['≥', 'Greater or equal'],
      ['∞', 'Infinity'],
      ['√', 'Square root'],
      ['°', 'Degree'],
      ['½', 'One half'],
      ['¼', 'One quarter'],
      ['¾', 'Three quarters'],
      ['²', 'Squared'],
      ['³', 'Cubed'],
      ['µ', 'Micro'],
      ['Ω', 'Ohm'],
      ['π', 'Pi'],
      ['∅', 'Empty set (diameter)'],
    ],
  },
  {
    label: 'Typography',
    symbols: [
      ['•', 'Bullet'],
      ['·', 'Middle dot'],
      ['…', 'Ellipsis'],
      ['–', 'En dash'],
      ['—', 'Em dash'],
      ['«', 'Left guillemet'],
      ['»', 'Right guillemet'],
      ['‹', 'Single left guillemet'],
      ['›', 'Single right guillemet'],
      ['©', 'Copyright'],
      ['®', 'Registered'],
      ['™', 'Trade mark'],
      ['§', 'Section'],
      ['¶', 'Pilcrow'],
      ['†', 'Dagger'],
      ['№', 'Numero'],
    ],
  },
  {
    label: 'Currency',
    symbols: [
      ['€', 'Euro'],
      ['£', 'Pound'],
      ['¥', 'Yen'],
      ['¢', 'Cent'],
    ],
  },
  {
    label: 'Marks',
    symbols: [
      ['✓', 'Check mark'],
      ['✗', 'Ballot X'],
      ['★', 'Star'],
      ['☐', 'Empty box'],
      ['☑', 'Checked box'],
      ['☒', 'Crossed box'],
      ['⚠', 'Warning'],
      ['⚡', 'High voltage'],
      ['⏻', 'Power'],
      ['●', 'Black circle'],
      ['■', 'Black square'],
    ],
  },
]
