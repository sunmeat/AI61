import { env, pipeline } from '@huggingface/transformers'
import { validateTranslationRequest } from './translator-validation.mjs'

const MODEL = 'Xenova/nllb-200-distilled-600M'
const REVISION = '261c31d1a5732c67cdd16d80e8d6088507c7ccea'
type Translator = (text: string, options?: { src_lang: string; tgt_lang: string }) => Promise<Array<{ translation_text?: string }>>
let translator: Translator | null = null
const createPipeline = pipeline as unknown as (task: string, model: string, options: Record<string, unknown>) => Promise<Translator>
let generation = 0

const workerEnv = env as typeof env & { backends: { onnx: { wasm: { wasmPaths: string; numThreads: number } } } }
workerEnv.allowLocalModels = false
workerEnv.allowRemoteModels = true
workerEnv.useBrowserCache = true
workerEnv.remoteHost = 'https://huggingface.co/'
workerEnv.remotePathTemplate = '{model}/resolve/{revision}/'
workerEnv.backends.onnx.wasm.wasmPaths = new URL('/wasm/', self.location.origin).href
workerEnv.backends.onnx.wasm.numThreads = 1

self.addEventListener('message', async (event: MessageEvent) => {
  const message = event.data as { type: 'load' | 'translate' | 'cancel'; runId: number; text?: string; source?: string; target?: string }
  const { runId } = message
  if (message.type === 'cancel') {
    generation += 1
    self.close()
    return
  }
  const current = ++generation
  const send = (data: Record<string, unknown>) => {
    if (current === generation) self.postMessage({ ...data, runId })
  }
  try {
    if (message.type === 'load') {
      if (!translator) {
        send({ type: 'phase', phase: 'downloading' })
        const initialized = await createPipeline('translation', MODEL, {
          revision: REVISION,
          dtype: 'q8',
          device: 'wasm',
          progress_callback: (progress: Record<string, unknown>) => send({ type: 'progress', progress }),
        })
        translator = initialized
        send({ type: 'phase', phase: 'warming' })
        const check = await initialized('Hello, this is a short recipe test.', { src_lang: 'eng_Latn', tgt_lang: 'ukr_Cyrl' })
        if (!Array.isArray(check) || typeof check[0]?.translation_text !== 'string' || !check[0].translation_text.trim()) {
          throw new Error('Перевірочний переклад моделі не повернув translation_text.')
        }
      }
      send({ type: 'ready' })
      return
    }
    if (message.type === 'translate') {
      if (!translator) throw new Error('Модель не ініціалізована. Натисніть «Завантажити модель».')
      const sourceLang = message.source ?? ''
      const targetLang = message.target ?? ''
      const validationError = validateTranslationRequest({ text: message.text, source: sourceLang, target: targetLang })
      if (validationError) throw new Error(validationError)
      send({ type: 'phase', phase: 'translating' })
      const result = await translator(message.text ?? '', { src_lang: sourceLang, tgt_lang: targetLang })
      const translated = Array.isArray(result) ? result[0]?.translation_text : undefined
      if (typeof translated !== 'string' || !translated.trim()) throw new Error('Модель не повернула translation_text.')
      send({ type: 'result', text: translated })
    }
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : 'Не вдалося виконати дію моделі.' })
  }
})
