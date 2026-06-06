import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' makes the production build work even when opened from a plain
// folder (file://) or any sub-path, not just a web server root.
export default defineConfig({
  plugins: [react()],
  base: './',
})
