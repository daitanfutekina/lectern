/**
 * What the packaged application must ship in `node_modules`, and whether
 * `electron-builder.yml` says so.
 *
 * Only the main process and the preload resolve modules at run time; the
 * renderer bundles everything it imports. So the shipping list is the bare
 * specifiers reachable from `out/main` and `out/preload`, plus their transitive
 * dependencies -- and it has to be computed rather than remembered, because the
 * first attempt was a `grep` for `require("...")` and the bundler had renamed
 * the identifier:
 *
 *   return require$2("pdfjs-dist/legacy/build/pdf.mjs");
 *
 * That one miss shipped a build where every dropped PDF vanished, because the
 * scan swallows a failed read as "not a book". `speech-rule-engine` and `temml`
 * went the same way and would have taken mathematics speech with them.
 *
 *   node build-tools/runtime-deps.mjs           # report, and check the yml
 *   node build-tools/runtime-deps.mjs --list    # just the yml lines, to paste
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const OUT = ['out/main', 'out/preload']

function jsFiles(dir) {
  const found = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.js') || e.name.endsWith('.mjs') || e.name.endsWith('.cjs')) found.push(p)
    }
  }
  if (existsSync(dir)) walk(dir)
  return found
}

/*
  Any identifier ending in a call with a single string literal: `require`,
  `require$2`, `import`, `__require`. Narrow enough not to match `.require(` on
  an unrelated object, wide enough to survive the bundler's renaming.
*/
const CALL = /(?:^|[^A-Za-z0-9_$.])(?:require|import)[A-Za-z0-9_$]*\s*\(\s*['"]([^'"]+)['"]\s*\)/g

const direct = new Set()
for (const dir of OUT) {
  for (const file of jsFiles(dir)) {
    const source = readFileSync(file, 'utf8')
    let m
    while ((m = CALL.exec(source))) {
      const spec = m[1]
      if (spec.startsWith('.') || spec.startsWith('node:')) continue
      // Electron is the host, and `url` is a Node builtin written bare.
      if (spec === 'electron' || spec === 'url') continue
      direct.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
    }
  }
}

if (direct.size === 0) {
  console.error('no specifiers found -- run `npm run build` first')
  process.exit(2)
}

/*
  Nothing is omitted, and one attempt to omit something is worth recording.

  @napi-rs/canvas is 37 MB and looks like pdf.js's Node rasteriser, which the
  main process never reaches -- it only ever calls getTextContent. The require
  is even guarded:

    try { canvas = require("@napi-rs/canvas"); }
    catch (ex) { warn(`Cannot load "@napi-rs/canvas" package: "${ex}".`); }

  So it was dropped, with that quotation as the reason. The packaged build then
  failed on every PDF with `ReferenceError: DOMMatrix is not defined`, because
  four lines further on pdf.js does:

    if (!globalThis.DOMMatrix) globalThis.DOMMatrix = canvas.DOMMatrix

  The require is a polyfill, not a renderer. The catch swallows the load and the
  throw arrives later, somewhere else, in a code path that reads text.

  Reading the guard was not evidence. Running the packaged build was.
*/

const closure = new Set()
const walk = (name) => {
  if (closure.has(name)) return
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join('node_modules', name, 'package.json'), 'utf8'))
  } catch {
    return
  }
  closure.add(name)
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) walk(dep)
}
for (const name of direct) walk(name)

const wanted = [...closure].sort()
const lines = wanted.map((n) => `  - node_modules/${n}/**`)

if (process.argv.includes('--list')) {
  console.log(lines.join('\n'))
  process.exit(0)
}

const yml = readFileSync('electron-builder.yml', 'utf8')
const listed = new Set(
  [...yml.matchAll(/^\s*-\s*node_modules\/((?:@[^/]+\/)?[^/*]+)\/\*\*\s*$/gm)].map((m) => m[1])
)

const missing = wanted.filter((n) => !listed.has(n))
const extra = [...listed].filter((n) => !closure.has(n)).sort()

console.log(`${direct.size} direct: ${[...direct].sort().join(', ')}`)
console.log(`${wanted.length} package(s) in the runtime closure, ${listed.size} listed in electron-builder.yml`)

if (missing.length) {
  console.log(`\n${missing.length} required but NOT shipped -- the packaged app will fail on these:`)
  for (const n of missing) console.log(`  - node_modules/${n}/**`)
}
if (extra.length) {
  console.log(`\n${extra.length} shipped but not reachable, and can go:`)
  for (const n of extra) console.log(`  ${n}`)
}
if (!missing.length && !extra.length) console.log('\nthe list matches what the build actually loads')

process.exit(missing.length ? 1 : 0)
