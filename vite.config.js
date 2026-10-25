import { defineConfig } from 'vite';

// Configuracao minima: site estatico puro, sem frameworks ou plugins extras.
// Base relativa permite publicar em qualquer sub-pasta (GitHub Pages, Netlify, Vercel).
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // Nomes de arquivo com hash para cache-busting seguro em producao.
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    open: false
  },
  preview: {
    host: '127.0.0.1',
    port: 4173
  }
});
