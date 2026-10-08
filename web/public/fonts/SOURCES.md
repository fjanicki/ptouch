# Bundled fonts

All fonts here are licensed under the **SIL Open Font License 1.1**. None of the four upstream
licences declares a Reserved Font Name. The licence text of each family sits next to its files
(`OFL-<Family>.txt`, copied unchanged from upstream). `web/src/render/fonts.ts` loads them with
the `FontFace` API.

## Subsetting

Every file was downloaded from the official upstream source below and then subset with
`pyftsubset` (fontTools 4.60.2, brotli 1.2.0) to woff2:

```sh
pyftsubset <upstream>.woff2 --flavor=woff2 --name-IDs='*' --name-languages='*' \
  --layout-features+=tnum,zero,frac,sups,subs,case --unicodes="$U" --output-file=<file>.woff2
```

`$U` is `U+0020-007E,U+00A0-017F,U+0192,U+0218-021B,U+02C6-02DD,U+0300-0308,U+030A-030C,U+0327,U+0370-03FF,U+1E9E,U+2000-206F,U+2070-209F,U+20A0-20CF,U+2100-214F,U+2150-218F,U+2190-21FF,U+2200-22FF,U+2300-23FF,U+2460-24FF,U+2500-257F,U+25A0-25FF,U+2600-26FF,U+2713-2717,U+FB01-FB02,U+FEFF,U+FFFD`.

That keeps Latin (incl. Latin-1 and Latin Extended-A), basic Greek (µ, Ω, Δ…), punctuation,
currency, letterlike symbols (№, ℃, Ω), number forms, arrows, maths (±, ≤, ×, √, ∞), technical
symbols (⌀) and geometric shapes, as far as each font covers them. Name tables (copyright and
licence) are kept in full. Italics are not bundled: the browser synthesises an oblique.

## Files

| File | Family | Weight | Upstream (version) | Upstream SHA-256 | Bundled SHA-256 |
|---|---|---|---|---|---|
| `FiraSans-Regular.woff2` | Fira Sans | 400 | [bBoxType/FiraSans](https://github.com/bBoxType/FiraSans) 4.301, commit `f54eeb3124c63fe9b5bcd36d09d1cd46788cd15e`, `Fira_Sans_4_3/Fonts/Fira_Sans_WEB_4301/Normal/Roman/FiraSans-Regular.woff2` | `51000d3cc8a601427bdb88625275e0eefc00570f4f2ab7a926fa336abee7098f` | `010e8ef9be9dffa4e7b87808e600c0680718b53070e43736fc41f34b038c270b` |
| `FiraSans-Medium.woff2` | Fira Sans | 500 | same, `…/FiraSans-Medium.woff2` | `14d421d4fb35d56b40e958cc9b64eb1528d1822bb75251623955c873a9a175d3` | `59e4d0e7b3835cbf04d01e60be463f64015b4e7feec8103bf6ed5d54524c2738` |
| `FiraSans-SemiBold.woff2` | Fira Sans | 600 | same, `…/FiraSans-SemiBold.woff2` | `01ca0c4a1f02dd4324721cf8766bcbb2edca4dee0fb8884a66e58e231ed62d55` | `c5d13d2d5b081701ed71cae3f5ef10aad9047cf2a8d8cb5678ac906d6986a191` |
| `FiraSans-Bold.woff2` | Fira Sans | 700 | same, `…/FiraSans-Bold.woff2` | `7dff4e2351ca54fae96180e79ab1d1fdeb74ebb6e6cba53a7d9d7b4941600ada` | `9d2ee6ca5f4532d718f6bbdc7a8e64e9566e8df3af87920ee4a68224bed56e56` |
| `FiraSans-ExtraBold.woff2` | Fira Sans | 800 | same, `…/FiraSans-ExtraBold.woff2` | `133482a0c7aa051cd89a9b6bf5ee990bad1bf1a4b37918b96a0d626fdb529bec` | `c041a28768ebf7415c49a11beff2a664502c9035730c61f44f94539358d45b26` |
| `ArchivoNarrow-Regular.woff2` | Archivo Narrow | 400 | [Omnibus-Type/ArchivoNarrow](https://github.com/Omnibus-Type/ArchivoNarrow) commit `9793ec77b6682a26bc7a6ed523ca65cc3cb90aec`, `fonts/webfonts/ArchivoNarrow-Regular.woff2` | `5b34e15998e0a4d6b6bf3377ebed3b9f3189f8a5511e3afbc2a7e0cfe1d03fdf` | `a4f9c875991ca6f715824dde6e26670dd8c923164e47a0a31524ee9180027e57` |
| `ArchivoNarrow-Medium.woff2` | Archivo Narrow | 500 | same, `fonts/webfonts/ArchivoNarrow-Medium.woff2` | `523fa4e3a2bd3b16f70022c75a3106410ec02eb5bf19ef720350d3c301e24581` | `08bdb13cef726fe839946079b6e2050be23ecfa1dda425e9983a45fcde0e7f49` |
| `ArchivoNarrow-SemiBold.woff2` | Archivo Narrow | 600 | same, `fonts/webfonts/ArchivoNarrow-SemiBold.woff2` | `ca6a15c936cc8c4cbdaf6a2aa0c4ff467b56625ed67e2cf4caecd41861c637da` | `31127f34364dce500c1cc55ba6de53aaea09364bff0b9dcb1e4695391d061262` |
| `ArchivoNarrow-Bold.woff2` | Archivo Narrow | 700 | same, `fonts/webfonts/ArchivoNarrow-Bold.woff2` | `c7143f25df2786f13467f13afa0bde2cb1a4844bd1606ae08127b9f76b524743` | `383c773dfe5b02744f69958c598ed2be808c40602c0025bd036f59b3c47f9d84` |
| `JetBrainsMono-Regular.woff2` | JetBrains Mono | 400 | [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono) release v2.304, `JetBrainsMono-2.304.zip` (SHA-256 `6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf`), `fonts/webfonts/JetBrainsMono-Regular.woff2` | `a9cb1cd82332b23a47e3a1239d25d13c86d16c4220695e34b243effa999f45f2` | `3183eddab3524a5802bf33933e56cada800c570db2aacbe5b1cdead4e0fad6db` |
| `JetBrainsMono-Bold.woff2` | JetBrains Mono | 700 | same zip, `fonts/webfonts/JetBrainsMono-Bold.woff2` | `c503cc5ec5f8b2c7666b7ecda1adf44bd45f2e6579b2eba0fc292150416588a2` | `87016d2525f1edec69345e5a8cf47fbcd7123ba57231352b5342f82b126f9573` |
| `AtkinsonHyperlegible-Regular.woff2` | Atkinson Hyperlegible | 400 | [googlefonts/atkinson-hyperlegible](https://github.com/googlefonts/atkinson-hyperlegible) (Braille Institute) commit `1cb311624b2ddf88e9e37873999d165a8cd28b46`, `fonts/webfonts/AtkinsonHyperlegible-Regular.woff2` | `2df4ba17804bc7a36f123127966075d8427bff2df58d0d76820c1130bb1a4150` | `077f49f1d8e26821a1f67a071af09360fa474303c76c205c672575d81f05202f` |
| `AtkinsonHyperlegible-Bold.woff2` | Atkinson Hyperlegible | 700 | same, `fonts/webfonts/AtkinsonHyperlegible-Bold.woff2` | `da8fce41a04f8498fbf79076f92d304b12e70c76f71b143c5dcfb6536c93c075` | `dd36c3052f098a4dd010c7ee64e0574f07308fbbd9a2443af1ed46395335d4fa` |

## Licence files

| File | Upstream | SHA-256 |
|---|---|---|
| `OFL-FiraSans.txt` | bBoxType/FiraSans `OFL.txt` (same commit) | `5c29650250730778eccb5475b112d32a8e0c9dd1860d9509693329652bf8e9eb` |
| `OFL-ArchivoNarrow.txt` | Omnibus-Type/ArchivoNarrow `OFL.txt` (same commit) | `b2087ef3fb91248e346600d19021249152a9688efea72905aa1996bb16a4c8de` |
| `OFL-JetBrainsMono.txt` | JetBrainsMono-2.304.zip `OFL.txt` | `30f0c136e3c88e422d0791acd97238870f9054a9729bc34cf2ff0d4ed8cac4ad` |
| `OFL-AtkinsonHyperlegible.txt` | googlefonts/atkinson-hyperlegible `OFL.txt` (same commit) | `f32d22b3908fcad2c86a74000614ec22e6a7f66ea7e867e616026a27aebdc143` |

Total: 13 woff2 files, about 520 KB. A label only loads the faces it uses.
