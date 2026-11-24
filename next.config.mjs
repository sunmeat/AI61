/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    }, {
      source: '/wasm/ort-wasm-simd-threaded.mjs',
      headers: [{ key: 'Content-Type', value: 'text/javascript; charset=utf-8' }],
    }, {
      source: '/wasm/ort-wasm-simd-threaded.jsep.mjs',
      headers: [{ key: 'Content-Type', value: 'text/javascript; charset=utf-8' }],
    }]
  },

}

export default nextConfig
