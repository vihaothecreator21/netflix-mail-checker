import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.BASE_PATH || '/netflix-mail-checker/',
  esbuild: { jsx: 'automatic' },
  plugins: [{
    name: 'production-csp',
    apply: 'build',
    transformIndexHtml() {
      return [{ tag: 'meta', injectTo: 'head-prepend', attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://script.google.com https://script.googleusercontent.com; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
      } }];
    },
  }],
});
