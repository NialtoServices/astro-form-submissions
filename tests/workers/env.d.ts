// The bindings vitest.workers.config.ts gives the tests, as `cloudflare:workers` exposes them inside workerd.
declare module 'cloudflare:workers' {
  import type { R2BucketLike } from '#storage/r2.js'

  export const env: { UPLOADS: R2BucketLike }
}

// A fixture imported with `?inline`, which the bundler hands over as a base64 `data:` URL.
declare module '*?inline' {
  const dataURL: string
  export default dataURL
}
