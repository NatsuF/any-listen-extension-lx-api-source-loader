import { getMusicUrl } from '../isolate'
import { configuration, console, musicUtils, registerResourceAction } from '../shared/hostAPI'

// The host's local proxy derives the cache file name from the url extension and
// rejects anything outside `MEDIA_FILE_TYPES` + `PIC_FILE_TYPES`
// (`mp3 flac ogg oga wav m4a` and the image types) with `Not allowed file type`.
// Vendors hand out their own containers - kuwo / QQ use `.mgg` and `.mflac` - so
// a perfectly playable link was thrown away and playback failed with it.
const HOST_PROXY_EXT_ERROR = 'Not allowed file type'

// Vendor container -> the standard extension the host accepts. `.mgg` really is
// OGG inside, `.mflac` really is FLAC, so the alias does not lie about the data.
const VENDOR_EXT_ALIAS: Record<string, string> = {
  '.mgg': '.ogg',
  '.mggl': '.ogg',
  '.mflac': '.flac',
  '.mflac0': '.flac',
  '.mflac1': '.flac',
}

// Mirrors the host's own `extname()` (it strips the query before taking the
// extension) so the decision here matches `checkAllowedExt` exactly.
const getUrlExt = (url: string) => {
  const slug = url.split('?')[0].split('#')[0].split('/').pop() ?? ''
  const dot = slug.lastIndexOf('.')
  return dot > 0 ? slug.slice(dot).toLowerCase() : ''
}

// The alias is appended as a url *fragment*: the host's `extname()` keeps it
// because it only strips `?query`, while the HTTP layer drops it before sending,
// so the origin still receives the byte identical request (verified against both
// kuwo and an undici fetch). A url that already carries a query string cannot be
// aliased this way - everything after `#` would become part of the fragment and
// swallow the credentials in the query - so those are left alone.
const buildAliasedUrl = (url: string) => {
  if (url.includes('?')) return null
  return `${url}#${VENDOR_EXT_ALIAS[getUrlExt(url)] ?? '.ogg'}`
}

const resolveProxyUrl = async (url: string, enabledCache: boolean) => {
  try {
    return await musicUtils.createProxyUrl(url, {}, enabledCache)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // `createProxy` verifies the resource *before* it checks the extension, so
    // any other failure means the link itself is unusable - rethrow and let the
    // host fall back to another source instead of handing back a dead url.
    if (!message.includes(HOST_PROXY_EXT_ERROR)) throw error

    const aliased = buildAliasedUrl(url)
    if (!aliased) {
      // Verified alive a moment ago, only the container name is unknown to the
      // host. Hand it over as is rather than dropping the song.
      console.warn(`host proxy rejected the container of [${url.slice(0, 128)}], falling back to the raw url`)
      return url
    }
    console.warn(`host proxy rejected the container of [${url.slice(0, 128)}], retrying as [${aliased.slice(-24)}]`)
    return await musicUtils.createProxyUrl(aliased, {}, enabledCache).catch((err: unknown) => {
      console.warn(
        `aliased proxy url failed too, falling back to the raw url: ${err instanceof Error ? err.message : String(err)}`
      )
      return url
    })
  }
}

export const initOnlineResource = async () => {
  registerResourceAction({
    async musicUrl(params) {
      const quality = params.quality || '128k'
      let url = await getMusicUrl(params.musicInfo, quality)
      console.log(`${params.musicInfo.name}, ${params.musicInfo.meta.source}, ${quality}: ${url}`)
      url = await resolveProxyUrl(url, (await configuration.getConfigs<[boolean]>(['enabledCache']))[0])
      console.log(`proxy: ${url}`)
      return { quality, url }
    },
  })
}
