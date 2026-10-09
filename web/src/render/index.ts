// Public surface of the render layer (lead-owned; packages import new render modules by path,
// e.g. '../../render/export', instead of editing this file).
export * from './types'
export * from './units'
export { itemSizingBand, renderLabel } from './renderer'
export { paintPreview, thumbnailPng } from './preview'
export { buildPrintJob, copiesOf, estimateTape, jobOptions, printBlocker, LEADER_MM, MAX_COPIES, type TapeEstimate } from './job'
export { FONTS, FONT_CATEGORIES, MIN_QUALITY_CAP_MM, fontDef, findFont, ensureFonts, loadFamily, familyReady, familyLoading, preloadAllFonts, resolveWeight, fontsUsed, textFaceReady, CODE_TEXT_FONT, type EnsureFontsOptions, type FontCategory, type FontDef, type FontLicense, type FontReport } from './fonts'
export { loadIcons, loadedIcons, type IconSet } from './icon-set'
export type { IconDef, IconCategory } from './icons'
export { codeMatrix, codePayload, codeSizeDots, maxModuleDots, quietModules, tapeMarginDots, isLinear, humanReadable, ean13CheckDigit, type CodeSize, type QuietZoneArg } from './codes'
export { wifiPayload } from './wifi'
export { canvasReadbackIsNoisy } from './antifp'
export { imageSize, dataUrlToBlob } from './images'
