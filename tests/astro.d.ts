// tsc can't parse .astro files; give test imports of components a typed shape.
declare module '*.astro' {
  import type { AstroComponentFactory } from 'astro/runtime/server/index.js'
  const component: AstroComponentFactory
  export default component
}
