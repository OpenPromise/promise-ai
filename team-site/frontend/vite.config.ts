import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 相对路径：构建产物可部署到 GitHub Pages 任意子路径
  base: './',
});
