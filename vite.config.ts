import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/Letterboxed-Stats/',
  plugins: [react()],
})