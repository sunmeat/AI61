'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownUp, ArrowRight, Check, ChefHat, CircleAlert, Download, LoaderCircle, RotateCcw, Sparkles, X } from 'lucide-react'
import { ResourceProgress } from '@/lib/resource-progress.mjs'
import { validateTranslationRequest } from '@/lib/translator-validation.mjs'

type Direction = 'uk-en' | 'en-uk'
type Resource = { path: string; url: string; bytes: number; required: boolean; kind: string; status?: string }
type ModelManifest = { modelId: string; revision: string; runtime: { version: string; onnxruntimeWeb: string; wasm: Array<{path:string;bytes:number}> }; resources: Resource[] }
type ProgressSummary = ReturnType<ResourceProgress['summary']>

const examples = [
  'Наріжте 2 помідори й обсмажте їх 5 хвилин.',
  'Додайте 150 г квасолі та тушкуйте до м’якості.',
  'Змішайте інгредієнти й залиште страву на 10 хвилин.',
]
const lang = (direction: Direction) => direction === 'uk-en' ? { source: 'ukr_Cyrl', target: 'eng_Latn', label: 'Українська → англійська' } : { source: 'eng_Latn', target: 'ukr_Cyrl', label: 'Англійська → українська' }
const formatBytes = (value: number) => value < 1024 ** 2 ? `${Math.round(value / 1024)} КБ` : `${(value / 1024 ** 2).toFixed(1)} МБ`

export function TranslatorApp() {
  const [direction, setDirection] = useState<Direction>('uk-en')
  const [source, setSource] = useState('')
  const [translation, setTranslation] = useState('')
  const [phase, setPhase] = useState<'idle'|'downloading'|'warming'|'ready'|'translating'|'error'>('idle')
  const [status, setStatus] = useState('Модель завантажується лише після вашого натискання.')
  const [error, setError] = useState('')
  const [manifest, setManifest] = useState<ModelManifest | null>(null)
  const [progress, setProgress] = useState<ProgressSummary | null>(null)
  const [elapsed, setElapsed] = useState<number | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const trackerRef = useRef<ResourceProgress | null>(null)
  const runRef = useRef(0)
  const startedAt = useRef(0)
  const currentDirection = useMemo(() => lang(direction), [direction])
  const busy = phase === 'downloading' || phase === 'warming' || phase === 'translating'
  const translatedReady = phase === 'ready'

  useEffect(() => () => workerRef.current?.terminate(), [])

  function attachWorker(worker: Worker, runId: number) {
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as { type: string; runId: number; phase?: string; progress?: Record<string, unknown>; text?: string; message?: string }
      if (message.runId !== runId || runId !== runRef.current) return
      if (message.type === 'progress' && message.progress) {
        const accepted = trackerRef.current?.apply(message.progress, runId)
        if (accepted) setProgress(trackerRef.current?.summary() ?? null)
      } else if (message.type === 'phase') {
        if (message.phase === 'downloading') { setPhase('downloading'); setStatus('Завантаження файлів моделі…') }
        if (message.phase === 'warming') { setPhase('warming'); setStatus('Файли отримано. Ініціалізація та коротка перевірка перекладу…') }
        if (message.phase === 'translating') { setPhase('translating'); setStatus('Модель перекладає текст…') }
      } else if (message.type === 'ready') {
        setPhase('ready'); setStatus(`Готово до перекладу · ${((performance.now() - startedAt.current) / 1000).toFixed(1)} с`); setElapsed((performance.now() - startedAt.current) / 1000); setError('')
      } else if (message.type === 'result') {
        setTranslation(message.text ?? ''); setPhase('ready'); setStatus('Переклад завершено. Текст оригіналу не змінено.')
      } else if (message.type === 'error') {
        setPhase('error'); setError(message.message || 'Невідома помилка моделі.'); setStatus('Не вдалося завершити дію.');
      }
    }
    worker.onerror = (event) => {
      if (runId !== runRef.current) return
      setPhase('error'); setError(event.message || 'Worker не запустився. Перевірте доступність локального JavaScript-файлу.'); setStatus('Помилка worker.')
    }
  }

  async function loadModel() {
    if (busy) return
    const runId = ++runRef.current
    setError(''); setTranslation(''); setElapsed(null); setPhase('downloading'); setStatus('Перевірка локальних ресурсів…'); startedAt.current = performance.now()
    try {
      const response = await fetch('/model-manifest.json', { cache: 'no-store' })
      if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) throw new Error(`Маніфест ресурсів недоступний або повернув неправильний MIME (HTTP ${response.status}).`)
      const loaded = await response.json() as ModelManifest
      if (runId !== runRef.current) return
      if (loaded.modelId !== 'Xenova/nllb-200-distilled-600M' || loaded.revision !== '261c31d1a5732c67cdd16d80e8d6088507c7ccea') throw new Error('Маніфест моделі не збігається з зафіксованим model ID/revision.')
      setManifest(loaded)
      const resources = loaded.resources.filter((item) => item.kind === 'model-weight' || item.kind === 'tokenizer-config')
      trackerRef.current = new ResourceProgress(resources.map((item) => ({ ...item, modelId: loaded.modelId, revision: loaded.revision })), loaded.revision, 'q8')
      const run = trackerRef.current.start()
      if ('caches' in window) {
        try {
          const cache = await window.caches.open('transformers-cache')
          for (const resource of resources) {
            const cached = await cache.match(resource.url)
            if (!cached || cached.status !== 200 || (cached.headers.get('content-type') || '').includes('text/html')) continue
            const reader = cached.clone().body?.getReader()
            if (!reader) continue
            const firstChunk = await reader.read()
            await reader.cancel()
            if (firstChunk.value?.byteLength) trackerRef.current.apply({ status: 'cached', file: resource.url }, run)
          }
        } catch {
          // Browser caching is optional; the model loader remains the source of truth.
        }
      }
      if (runId !== runRef.current) return
      setProgress(trackerRef.current.summary())
      const worker = new Worker(new URL('/translator.worker.js', window.location.origin), { type: 'module', name: 'recipe-translator' })
      workerRef.current?.terminate(); workerRef.current = worker
      attachWorker(worker, runId)
      worker.postMessage({ type: 'load', runId })
    } catch (caught) {
      if (runId !== runRef.current) return
      const message = caught instanceof Error ? caught.message : 'Не вдалося завантажити модель.'
      setPhase('error'); setError(message); setStatus('Збій підготовки моделі.')
    }
  }

  function cancelLoad() {
    runRef.current += 1
    trackerRef.current?.cancel()
    workerRef.current?.terminate(); workerRef.current = null
    setPhase('idle'); setStatus('Завантаження скасовано. Повторіть лише за потреби.'); setError(''); setProgress(null)
  }

  function translate() {
    if (busy) return
    const validationError = validateTranslationRequest({ text: source, source: currentDirection.source, target: currentDirection.target })
    if (validationError) { setError(validationError); return }
    if (!workerRef.current || !translatedReady) { setError('Спершу завантажте й перевірте модель.'); return }
    setError(''); setTranslation('')
    const runId = ++runRef.current
    attachWorker(workerRef.current, runId)
    workerRef.current.postMessage({ type: 'translate', runId, text: source, source: currentDirection.source, target: currentDirection.target })
  }

  function switchDirection() { setDirection((value) => value === 'uk-en' ? 'en-uk' : 'uk-en'); setTranslation(''); setError('') }
  const visibleResources = progress?.rows ?? []
  const loadLabel = phase === 'ready' ? 'Модель готова' : phase === 'error' ? 'Спробувати ще раз' : phase === 'downloading' ? 'Завантаження…' : phase === 'warming' ? 'Перевірка моделі…' : 'Завантажити модель'

  return <main className="page-shell">
    <header className="topbar"><a href="#main" className="brand" aria-label="До перекладача"><span className="brand-mark"><ChefHat size={19} /></span><span>Смаколад<span className="brand-dot">.</span></span></a><span className="topbar-note"><span className="local-dot" /> Переклад на вашому пристрої</span></header>
    <section className="hero" id="main">
      <div className="eyebrow"><span className="eyebrow-line" /> КУХОННИЙ ПОМІЧНИК <span className="eyebrow-line" /></div>
      <h1>Слова теж мають<br/><em>смак.</em></h1>
      <p className="hero-copy">Перекладіть короткий текст рецепту — інгредієнти й кроки залишаться під рукою.</p>
    </section>

    <section className="translator-card" aria-label="Перекладач рецепту">
      <div className="card-toolbar">
        <div className="direction-wrap"><span className="direction-label">НАПРЯМОК</span><span className="direction-value">{currentDirection.label}</span><button type="button" className="swap-button" onClick={switchDirection} aria-label="Змінити напрямок перекладу" title="Змінити напрямок"><ArrowDownUp size={17}/></button></div>
        <span className="model-tag"><span className={`status-dot ${translatedReady ? 'is-ready' : ''}`} /> {translatedReady ? 'Локальна модель готова' : 'Модель NLLB-200'}</span>
      </div>
      <div className="editor-grid">
        <div className="editor-panel">
          <div className="panel-head"><label htmlFor="source-text">ОРИГІНАЛ <span className="language-pill">{direction === 'uk-en' ? 'Українська' : 'English'}</span></label><span className="character-count">{source.length}/1 400</span></div>
          <textarea id="source-text" value={source} onChange={(event) => { setSource(event.target.value); if (error) setError('') }} maxLength={1600} placeholder="Наприклад: Наріжте 2 помідори й обсмажте їх 5 хвилин." aria-describedby="input-hint" />
          <div className="input-foot"><span id="input-hint">1–3 короткі речення — найкраще для першої спроби</span><button type="button" className="text-button" onClick={() => { setSource(''); setTranslation(''); setError('') }} disabled={!source}>Очистити</button></div>
        </div>
        <div className="editor-panel output-panel">
          <div className="panel-head"><span>ПЕРЕКЛАД <span className="language-pill">{direction === 'uk-en' ? 'English' : 'Українська'}</span></span><span className="output-state">{translation ? <><Check size={13}/> Готово</> : 'Результат'}</span></div>
          <div className={`translation-output ${translation ? 'has-result' : ''}`} aria-live="polite" aria-atomic="true">{translation || <span className="output-placeholder">Тут з&apos;явиться переклад</span>}</div>
          <div className="input-foot"><span>Переклад виконується локально у браузері</span><span className="output-lock">NLLB · WASM</span></div>
        </div>
      </div>

      <div className="action-row">
        <button type="button" className={`load-button ${translatedReady ? 'ready-button' : ''}`} onClick={loadModel} disabled={busy || translatedReady}><Download size={17}/>{loadLabel}</button>
        <button type="button" className="translate-button" onClick={translate} disabled={!translatedReady || busy}><span>{phase === 'translating' ? <LoaderCircle className="spin" size={17}/> : <Sparkles size={17}/>}</span>{phase === 'translating' ? 'Перекладаємо…' : 'Перекласти'}<ArrowRight size={16}/></button>
        {(phase === 'downloading' || phase === 'warming') && <button type="button" className="cancel-button" onClick={cancelLoad} aria-label="Скасувати завантаження"><X size={16}/> Скасувати</button>}
      </div>

      <div className="status-region" aria-live="polite" aria-atomic="true">
        <div className={`status-message ${phase === 'error' ? 'status-error' : ''}`}>
          {phase === 'error' ? <CircleAlert size={16}/> : phase === 'ready' ? <Check size={16}/> : busy ? <LoaderCircle className="spin" size={16}/> : <span className="status-icon"><Sparkles size={14}/></span>}
          <span>{error || status}</span>
        </div>
        {elapsed !== null && phase === 'ready' && <span className="elapsed">Завантаження й перевірка: {elapsed.toFixed(1)} с</span>}
        {phase === 'downloading' && progress && <div className="progress-overview">
          <div className="progress-title"><span>{progress.percent === null ? 'Завантаження файлів моделі' : `Завантаження моделі · ${progress.percent}%`}</span><span>{progress.verified}/{progress.count} перевірено</span></div>
          <div className="progress-track" role="progressbar" aria-label="Загальний прогрес відомих ресурсів" aria-valuemin={0} aria-valuemax={100} {...(progress.percent === null ? {} : { 'aria-valuenow': progress.percent })}><span style={{ width: progress.percent === null ? '34%' : `${progress.percent}%` }} className={progress.percent === null ? 'indeterminate-bar' : ''}/></div>
          <span className="bytes-summary">{formatBytes(progress.available)} отримано з {progress.total ? formatBytes(progress.total) : 'невідомого обсягу'} · сумарний відсоток не охоплює невідомі ресурси</span>
          <ul className="resource-list" aria-label="Стан файлів">
            {visibleResources.map((resource) => <li key={resource.key} className="resource-row"><span className="resource-file-name" title={resource.path || resource.file}>{(resource.path || resource.file || 'Ресурс').split('/').slice(-2).join('/')}</span><span className={`resource-state state-${resource.status}`}>{resource.status === 'verified' ? 'Перевірено' : resource.status === 'cached' ? 'З кешу' : resource.status === 'error' ? 'Помилка' : resource.status === 'downloading' ? 'Завантажується' : resource.status === 'retrying' ? 'Повтор' : 'Очікує'}</span><span className="resource-bytes">{formatBytes(resource.loaded)} / {resource.total ? formatBytes(resource.total) : '—'}</span><span className="file-track"><span style={{ width: resource.total ? `${Math.min(100, resource.loaded / resource.total * 100)}%` : '0%' }}/></span></li>)}
          </ul>
          {manifest && <p className="manifest-note">{manifest.modelId} · revision {manifest.revision.slice(0, 8)} · Transformers.js {manifest.runtime.version} / ONNX Runtime {manifest.runtime.onnxruntimeWeb}</p>}
        </div>}
        {phase === 'warming' && <div className="warming-note"><LoaderCircle className="spin" size={15}/> Файли готові — виконується ініціалізація та перевірочний переклад.</div>}
      </div>

      <div className="examples"><div className="examples-heading"><span>СПРОБУЙТЕ НА ПРИКЛАДІ</span><span className="examples-rule"/></div><div className="example-list">{examples.map((example, index) => <button type="button" key={example} className="example-chip" onClick={() => { setSource(example); setError(''); setTranslation('') }}><span>0{index + 1}</span>{example}</button>)}</div></div>
    </section>
    <footer className="page-footer"><span>Переклад створюється моделлю на вашому пристрої.</span><span>Перевіряйте точність інгредієнтів і чисел самостійно.</span></footer>
    <aside className="notice"><RotateCcw size={14}/> Це переклад тексту, а не порада щодо харчування чи гарантія відсутності алергенів. Ліцензія NLLB: CC-BY-NC-4.0, некомерційне використання.</aside>
  </main>
}
