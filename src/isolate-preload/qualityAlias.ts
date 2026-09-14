/**
 * any-listen's `QUALITYS` only has eight slots:
 *   128k / 192k / 320k / wav / flac / flac24bit / dolby / master
 *
 * but LX Music scripts declare the tiers their own backend understands
 * (`hires`, `atmos`, `atmos_plus`, ...). The host filters the script's
 * declaration by *literal string intersection*, so a name mismatch silently
 * drops a whole tier:
 *
 *   - picking "Dolby Atmos" in settings sends `dolby`; the script only knows
 *     `atmos`, so the request degrades tier by tier down to `flac24bit`
 *   - a tier the script *can* serve (`atmos`, `hires`) has no kernel slot, so
 *     it is unreachable from the UI
 *
 * This module restores the missing mapping in both directions: normalize the
 * script's keys into kernel keys when registering sources, then translate the
 * kernel key back into the script's own key when asking for a URL.
 */

type AliasGroup = {
  /** Kernel key, must exist in `QUALITYS`. */
  kernel: string
  /**
   * Script-side spellings, highest priority first. The first declared entry
   * wins, the rest are reported as shadowed.
   */
  aliases: string[]
}

/**
 * Group order is tier priority (highest first). Keep the table conservative:
 * only add a spelling here when it unambiguously means the same tier.
 */
const ALIAS_GROUPS: AliasGroup[] = [
  // `atmos_plus` sits below a real master, so it only claims the top slot when
  // the script has no `master` of its own.
  { kernel: 'master', aliases: ['master', 'atmos_plus'] },
  { kernel: 'dolby', aliases: ['dolby', 'atmos'] },
  { kernel: 'flac24bit', aliases: ['flac24bit', 'flac_24bit', 'hires', 'hi_res'] },
  { kernel: 'flac', aliases: ['flac'] },
  { kernel: 'wav', aliases: ['wav'] },
  { kernel: '320k', aliases: ['320k'] },
  { kernel: '192k', aliases: ['192k'] },
  { kernel: '128k', aliases: ['128k'] },
]

export type QualityNormalizeResult = {
  /** Kernel keys this script can serve, following `ALIAS_GROUPS` priority. */
  qualitys: string[]
  /** Kernel key -> the exact string the script declared. Only renamed tiers. */
  reverse: Record<string, string>
  /** Tiers that were renamed to fit a kernel slot. */
  aliased: Array<{ kernel: string; alias: string }>
  /** Extra spellings of the same tier that lost to a higher-priority alias. */
  shadowed: Array<{ kernel: string; alias: string; winner: string }>
  /** Declared keys with no kernel slot at all, so they cannot be reached. */
  dropped: string[]
}

export const normalizeQualitys = (declared?: unknown): QualityNormalizeResult => {
  // Keep the original spelling: scripts sometimes use uppercase keys, and the
  // URL request must replay exactly what the script declared.
  const declaredMap = new Map<string, string>()
  for (const item of Array.isArray(declared) ? declared : []) {
    if (typeof item !== 'string') continue
    const original = item.trim()
    if (!original) continue
    const key = original.toLowerCase()
    if (!declaredMap.has(key)) declaredMap.set(key, original)
  }

  const qualitys: string[] = []
  const reverse: Record<string, string> = {}
  const aliased: Array<{ kernel: string; alias: string }> = []
  const shadowed: Array<{ kernel: string; alias: string; winner: string }> = []
  const consumed = new Set<string>()

  for (const { kernel, aliases } of ALIAS_GROUPS) {
    const hits = aliases.filter((alias) => declaredMap.has(alias))
    const winner = hits[0]
    if (!winner) continue
    for (const alias of hits) consumed.add(alias)
    qualitys.push(kernel)
    const winnerOriginal = declaredMap.get(winner) ?? winner
    if (winnerOriginal !== kernel) {
      reverse[kernel] = winnerOriginal
      aliased.push({ kernel, alias: winnerOriginal })
    }
    for (const alias of hits.slice(1)) {
      shadowed.push({ kernel, alias: declaredMap.get(alias) ?? alias, winner: winnerOriginal })
    }
  }

  const dropped: string[] = []
  for (const [key, original] of declaredMap) {
    if (!consumed.has(key)) dropped.push(original)
  }

  return { qualitys, reverse, aliased, shadowed, dropped }
}

/** Builds a one-line diagnostic, empty when nothing was rewritten. */
export const describeNormalize = (source: string, result: QualityNormalizeResult) => {
  const parts: string[] = []
  if (result.aliased.length) {
    parts.push(`alias ${result.aliased.map((item) => `${item.alias}->${item.kernel}`).join(' ')}`)
  }
  if (result.shadowed.length) {
    parts.push(`shadowed ${result.shadowed.map((item) => `${item.alias}->${item.winner}`).join(' ')}`)
  }
  if (result.dropped.length) {
    parts.push(`dropped ${result.dropped.join(' ')}`)
  }
  return parts.length ? `[quality] ${source}: ${parts.join(' | ')}` : ''
}
