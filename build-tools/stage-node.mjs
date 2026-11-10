/**
 * Stage a real Node binary for the packaged application to spawn.
 *
 * The synthesis worker cannot run on Electron. `ELECTRON_RUN_AS_NODE` gets as
 * far as loading the models and reporting ready, and then every utterance
 * fails with "External buffers are not allowed" -- V8's sandbox is compiled
 * into Electron and rejects the memory sherpa-onnx and the ONNX runtime hand
 * back, which is the reason the worker is a separate process at all.
 *
 * Measured against the packaged build, same worker and same voice:
 *
 *   Electron, ELECTRON_RUN_AS_NODE=1   {"ready":true} then
 *                                      {"ok":false,"error":"External buffers
 *                                       are not allowed"}
 *   node.exe                           {"ready":true} then {"ok":true,"pcm":...}
 *
 * The alternative was to keep spawning `node` from PATH, which is what
 * development does and what an installed copy cannot assume. 81 MB is the
 * price of neural voices that work on a machine without Node on it.
 *
 *   node build-tools/stage-node.mjs
 */
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const OUT = 'build/node.exe'

// The Node running this script: whatever built the app is what will run the
// worker, so the version cannot drift between the two.
const from = process.execPath
if (/electron/i.test(from)) {
  console.error('run this with node, not electron -- got ' + from)
  process.exit(1)
}

mkdirSync('build', { recursive: true })
copyFileSync(from, OUT)

// The native modules are N-API (napi-v6), which is ABI-stable, so any Node
// that can load them will do. Check rather than assume.
const version = execFileSync(OUT, ['-p', 'process.version'], { encoding: 'utf8' }).trim()
const mb = (statSync(OUT).size / 1048576).toFixed(0)
console.log(`staged ${OUT} from ${from} (${version}, ${mb} MB)`)
