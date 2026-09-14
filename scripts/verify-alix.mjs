/**
 * Pre-release sanity check for the built .alix package.
 *
 * It replicates exactly how any-listen reads the signature file, which is the
 * part that is easy to get wrong: the host does
 *
 *   const [sign, pubKey] = sigFile.split('\n')
 *   verify(extBundle, `-----BEGIN PUBLIC KEY-----\n${pubKey}\n-----END PUBLIC KEY-----`, sign)
 *
 * so it only ever uses the SECOND line of `sig` as the public key body. If the
 * build writes an armored multi-line PEM there, line 2 becomes the header
 * itself and the PEM decoder fails at install time with
 * `error:09000064:PEM routines:OPENSSL_internal:BAD_BASE64_DECODE`.
 *
 * Usage: node scripts/verify-alix.mjs [path/to/*.alix]
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

const PEM_HEADER = '-----BEGIN PUBLIC KEY-----\n'
const PEM_FOOTER = '\n-----END PUBLIC KEY-----'

const parseTar = (buf) => {
  const files = new Map()
  let off = 0
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const typeFlag = String.fromCharCode(header[156])
    const dataStart = off + 512
    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === ' ') {
      files.set((prefix ? `${prefix}/${name}` : name).replace(/^\.\//, ''), buf.subarray(dataStart, dataStart + size))
    }
    off = dataStart + Math.ceil(size / 512) * 512
  }
  return files
}

const fail = (msg) => {
  console.error(`::error::${msg}`)
  process.exitCode = 1
}

const check = (ok, msg) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${msg}`)
  if (!ok) fail(msg)
}

const targets = process.argv.slice(2)
if (targets.length === 0) fail('no .alix path given')
const alixPath = targets[0]

console.log(`verifying ${path.basename(alixPath)}`)

const outer = parseTar(gunzipSync(fs.readFileSync(alixPath)))
const bundle = outer.get('ext.tgz')
const sigRaw = outer.get('sig')?.toString('utf8')

check(!!bundle, 'package contains ext.tgz')
check(!!sigRaw, 'package contains sig')

if (bundle && sigRaw) {
  const lines = sigRaw.split('\n')
  const [sign, pubKey] = lines

  // The failure that shipped v0.1.8: an armored PEM in the signature file.
  check(!pubKey.includes('-----'), `sig line 2 is a raw base64 body (got ${JSON.stringify(pubKey.slice(0, 40))})`)
  check(pubKey.length > 0 && /^[A-Za-z0-9+/=]+$/.test(pubKey), 'sig line 2 is pure base64')

  const verify = crypto.createVerify('SHA256')
  verify.update(bundle)
  verify.end()
  let verified = false
  try {
    verified = verify.verify(`${PEM_HEADER}${pubKey}${PEM_FOOTER}`, sign, 'hex')
  } catch (err) {
    check(false, `signature verification threw (${err.code ?? err.message}) — any-listen would reject this package`)
  }
  check(verified, 'signature verifies the way any-listen verifies it')

  // Version consistency: a mismatch here silently breaks in-app self-update.
  const manifest = parseTar(gunzipSync(bundle)).get('manifest.json')
  if (manifest) {
    const manifestVersion = JSON.parse(manifest.toString('utf8')).version
    const pkgVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
    const published = JSON.parse(fs.readFileSync('publish/version.json', 'utf8'))
    check(manifestVersion === pkgVersion, `manifest.json version (${manifestVersion}) matches package.json (${pkgVersion})`)
    check(published.version === pkgVersion, `publish/version.json version (${published.version}) matches package.json (${pkgVersion})`)
    check(
      published.download_url.includes(`/v${pkgVersion}/`),
      `publish/version.json download_url points at v${pkgVersion}`
    )
  } else {
    console.log('  note  manifest.json not readable, skipped version checks')
  }
}

console.log(process.exitCode ? 'package check FAILED' : 'package check passed')
