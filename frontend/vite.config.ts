import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/*
 * Fills in public/sw.js for this build: the files to keep for offline use and a
 * version taken from their contents, so each deploy that changes anything installs
 * a new cache (and offers the "new version" prompt). Only the app shell is listed:
 * the entry, the Study page and what it loads (offline flashcards, math) and the
 * static public files. Other
 * hashed chunks are cached the first time they load.
 */
function serviceWorkerManifest(): Plugin {
  const OFFLINE_PAGES = [/\/src\/pages\/Tools\.tsx$/]
  const PUBLIC_SHELL = [
    '/index.html',
    '/privacy/index.html',
    '/terms/index.html',
    '/legal/legal.css',
    '/theme-init.js',
    '/load-fonts.js',
    '/manifest.webmanifest',
    '/bindit-mascot-cutout.webp',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/apple-touch-icon.png',
  ]
  let outDir = 'dist'
  let assets: string[] = []
  return {
    name: 'bindit-service-worker-manifest',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    generateBundle(_options, bundle) {
      const files = new Set<string>()
      // deep: also what the chunk loads on demand (used for the offline pages only).
      const visit = (fileName: string, deep = false) => {
        const chunk = bundle[fileName]
        if (!chunk || files.has(fileName)) return
        files.add(fileName)
        if (chunk.type !== 'chunk') return
        chunk.imports.forEach((name) => visit(name, deep))
        chunk.viteMetadata?.importedCss.forEach((name) => visit(name))
        if (deep) chunk.dynamicImports.forEach((name) => visit(name, deep))
      }
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue
        const offlinePage = chunk.moduleIds.some((id) => OFFLINE_PAGES.some((page) => page.test(id)))
        // The Study page loads math rendering on demand: flashcards with formulas need it offline too.
        if (chunk.isEntry || offlinePage) visit(chunk.fileName, offlinePage)
      }
      // Fonts the shell's stylesheets use (woff2 only: every supported browser takes it).
      for (const item of Object.values(bundle)) if (/\.woff2$/.test(item.fileName)) files.add(item.fileName)
      assets = [...files].map((file) => `/${file}`).sort()
    },
    closeBundle() {
      const swPath = resolve(outDir, 'sw.js')
      if (!existsSync(swPath)) return
      // Some chunks are dropped after bundling (an import of CSS alone): list only files that were written.
      const precache = [...PUBLIC_SHELL, ...assets].filter((path) => existsSync(resolve(outDir, `.${path}`)))
      const hash = createHash('sha256')
      for (const path of precache) hash.update(path).update(readFileSync(resolve(outDir, `.${path}`)))
      hash.update(readFileSync(swPath))
      const version = hash.digest('hex').slice(0, 12)
      const source = readFileSync(swPath, 'utf8')
        .replace('__BINDIT_SW_VERSION__', version)
        .replace(/\/\* __BINDIT_SW_PRECACHE__ \*\/ \[[^\]]*\]/, JSON.stringify(precache))
      writeFileSync(swPath, source)
    },
  }
}

export default defineConfig({
  plugins: [react(), serviceWorkerManifest()],
  build: {
    // The CSP allows fonts only from this origin (font-src 'self'), so fonts such as
    // KaTeX's must be emitted as files, never inlined as data: URLs.
    assetsInlineLimit: (filePath) => (/\.(woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined),
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
