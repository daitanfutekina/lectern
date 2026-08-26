import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const shared = resolve(__dirname, 'src/shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          /*
            The synthesis worker is built alongside the main process but is not
            part of it: it is spawned as a plain Node process, because a
            sandboxed V8 refuses the external ArrayBuffers both sherpa-onnx and
            onnxruntime hand back. Building it here is what lets it import from
            `@shared` like everything else instead of keeping a second copy of
            the signal processing in hand-written CommonJS.
          */
          'voice-worker': resolve(__dirname, 'src/worker/voice-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } }
  },
  renderer: {
    // The Markdown pipeline is bundled into the renderer rather than
    // externalised: the renderer has no module resolution at runtime.
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
})
