// Public surface of the render layer (lead-owned; packages import new render modules by path,
// e.g. '../../render/export', instead of editing this file).
export * from './types'
export * from './units'
export { itemSizingBand, renderLabel } from './renderer'
export { paintPreview, thumbnailPng } from './preview'
export { buildPrintJob, copiesOf, estimateTape, jobOptions, printBlocker, LEADER_MM, MAX_COPIES, type TapeEstimate } from './job'
export { FONTS, fontDef, ensureFonts, preloadAllFonts, resolveWeight, fontsUsed, textFaceReady, CODE_TEXT_FONT, type EnsureFontsOptions, type FontDef, type FontReport } from './fonts'
export { ICONS, ICON_CATEGORIES, iconById, searchIcons, type IconDef, type IconCategory } from './icons'
export { codeMatrix, codePayload, codeSizeDots, maxModuleDots, quietModules, tapeMarginDots, isLinear, humanReadable, ean13CheckDigit, type CodeSize, type QuietZoneArg } from './codes'
export { wifiPayload } from './wifi'
export { canvasReadbackIsNoisy } from './antifp'
export { imageSize, dataUrlToBlob } from './images'
