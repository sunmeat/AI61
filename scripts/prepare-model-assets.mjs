import { mkdir, readFile, readdir, stat, writeFile, copyFile, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modelId = 'Xenova/nllb-200-distilled-600M'
const revision = '261c31d1a5732c67cdd16d80e8d6088507c7ccea'
const referenceSpace = 'Xenova/react-translator'
const referenceRevision = 'fd1f3d6685aaa373773dbb6b2d001e76df67c7ee'
const modelBase = `https://huggingface.co/${modelId}/resolve/${revision}/`
const expected = {
  'config.json': 873,
  'tokenizer.json': 17331224,
  'tokenizer_config.json': 544,
  'onnx/encoder_model_quantized.onnx': 419120483,
  'onnx/decoder_model_merged_quantized.onnx': 475505771,
}
const fail = (message) => { throw new Error(`[prepare-model-assets] ${message}`) }

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
if (pkg.dependencies['@huggingface/transformers'] !== '3.7.2') fail('Expected @huggingface/transformers 3.7.2.')
const runtimePkg = JSON.parse(await readFile(path.join(root, 'node_modules/@huggingface/transformers/package.json'), 'utf8'))
const ortDir = await realpath(path.join(root, 'node_modules/.pnpm/@huggingface+transformers@3.7.2/node_modules/onnxruntime-web'))
const ortPackagePath = path.join(ortDir, 'package.json')
const ortPkg = JSON.parse(await readFile(ortPackagePath, 'utf8'))
if (runtimePkg.version !== '3.7.2') fail(`Installed Transformers.js is ${runtimePkg.version}, expected 3.7.2.`)
if (ortPkg.version !== '1.22.0-dev.20250409-89f8206ba4') fail(`Installed onnxruntime-web is ${ortPkg.version}, expected 1.22.0-dev.20250409-89f8206ba4 (the version declared by Transformers.js 3.7.2).`)

const treeUrl = `https://huggingface.co/api/models/${modelId}/tree/${revision}?recursive=true&expand=true`
const treeResponse = await fetch(treeUrl)
if (!treeResponse.ok) fail(`Model revision listing returned HTTP ${treeResponse.status}: ${treeUrl}`)
const tree = await treeResponse.json()
const externalDataFiles = tree.filter((item) => item.type === 'file' && item.path.includes('.onnx_data'))
if (externalDataFiles.length) fail(`Pinned q8 model has external ONNX data files that are not declared in the manifest: ${externalDataFiles.map((item) => item.path).join(', ')}`)
for (const [resourcePath, size] of Object.entries(expected)) {
  const file = tree.find((item) => item.type === 'file' && item.path === resourcePath)
  if (!file) fail(`Required model file is absent at pinned revision ${revision}: ${resourcePath}`)
  if (file.size !== size) fail(`Unexpected size for ${resourcePath}: metadata=${file.size}, verified=${size}`)
}

const wasmSource = path.join(ortDir, 'dist')
const wasmFiles = (await readdir(wasmSource)).filter((name) => name === 'ort-wasm-simd-threaded.wasm')
if (!wasmFiles.length) fail(`No ONNX Runtime WASM assets found in ${wasmSource}`)
const wasmTarget = path.join(root, 'public/wasm')
await mkdir(wasmTarget, { recursive: true })
await unlink(path.join(wasmTarget, 'ort-wasm-simd-threaded.jsep.wasm')).catch(() => {})
const runtimeAssets = []
for (const name of wasmFiles) {
  const from = path.join(wasmSource, name)
  const to = path.join(wasmTarget, name)
  await copyFile(from, to)
  const { size } = await stat(to)
  if (!size) fail(`Copied runtime asset is empty: ${name}`)
  runtimeAssets.push({ name, path: `/wasm/${name}`, bytes: size, contentType: 'application/wasm', required: true, status: 'same-origin' })
}

const workerOut = path.join(root, 'public/translator.worker.js')
await build({
  entryPoints: [path.join(root, 'lib/translator.worker.ts')],
  outfile: workerOut,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: false,
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
})
const workerStat = await stat(workerOut)
if (!workerStat.size) fail('Bundled worker is empty.')

const modelFiles = Object.entries(expected).map(([resourcePath, bytes]) => ({
  modelId, revision, path: resourcePath, url: `${modelBase}${resourcePath}`, bytes,
  required: true, dtype: 'q8', source: 'huggingface-cors', contentType: resourcePath.endsWith('.onnx') ? 'application/octet-stream' : 'application/json-or-model',
}))
const manifest = {
  modelId,
  revision,
  reference: { space: referenceSpace, revision: referenceRevision, url: `https://huggingface.co/spaces/${referenceSpace}/tree/${referenceRevision}` },
  modelCard: { url: `https://huggingface.co/${modelId}/tree/${revision}`, license: 'cc-by-nc-4.0 (non-commercial use only)' },
  modelLicense: 'cc-by-nc-4.0 (upstream model card; non-commercial use only)',
  runtimeLicenses: { transformersJs: 'Apache-2.0', onnxruntimeWeb: 'MIT' },
  runtime: { name: '@huggingface/transformers', version: runtimePkg.version, onnxruntimeWeb: ortPkg.version, device: 'wasm-cpu', numThreads: 1, dtype: 'q8', worker: '/translator.worker.js', workerContentType: 'text/javascript', wasm: runtimeAssets },
  resources: [
    { kind: 'worker', path: '/translator.worker.js', bytes: workerStat.size, required: true, source: 'same-origin', status: 'built' },
    ...runtimeAssets.map(({ name, ...asset }) => ({ kind: 'runtime-wasm', ...asset })),
    ...modelFiles.map((file) => ({ kind: file.path.endsWith('.onnx') ? 'model-weight' : 'tokenizer-config', ...file, status: 'pending' })),
  ],
}
await writeFile(path.join(root, 'public/model-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

for (const [resourcePath, bytes] of Object.entries(expected)) {
  const url = `${modelBase}${resourcePath}`
  const response = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' })
  if (!(response.ok || response.status === 206)) fail(`Pinned resource probe failed for ${resourcePath}: HTTP ${response.status} (${url})`)
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (contentType.includes('text/html')) fail(`Pinned resource returned HTML instead of model data: ${resourcePath}`)
  if (resourcePath.endsWith('.onnx')) {
    if (response.status !== 206) fail(`ONNX Range probe must return HTTP 206 (got ${response.status}) for ${resourcePath}; refusing a full-weight response.`)
    if (!contentType.includes('application/octet-stream') || contentType.includes('json')) fail(`ONNX resource returned unexpected MIME ${contentType || '(missing)'} for ${resourcePath}; expected application/octet-stream.`)
    const range = response.headers.get('content-range')
    if (!range || !range.endsWith(`/${bytes}`)) fail(`Range size mismatch for ${resourcePath}: expected ${bytes}, Content-Range=${range ?? 'missing'}`)
    const sample = new Uint8Array(await response.arrayBuffer())
    if (sample.byteLength !== 1) fail(`ONNX Range probe must read exactly 1 byte for ${resourcePath}, got ${sample.byteLength}.`)
  } else {
    await response.body?.cancel()
  }
}

console.log(`[prepare-model-assets] Ready: Transformers.js ${runtimePkg.version}, ONNX Runtime ${ortPkg.version}, ${runtimeAssets.length} same-origin WASM file(s), ${modelFiles.length} pinned model resources, worker ${workerStat.size} bytes.`)
console.log(`[prepare-model-assets] Weights load only after user action. Hugging Face source: ${modelId}@${revision}. License: cc-by-nc-4.0.`)
