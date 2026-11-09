import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

// `npm run icons` regenerates the PNG/ICO files in public/ from assets/icon.svg.
// The generator writes next to its source image, so scripts/move-icons.mjs relocates the output.
export default defineConfig({
  preset: {
    ...minimal2023Preset,
    transparent: { ...minimal2023Preset.transparent, sizes: [192, 512] },
  },
  images: ['assets/icon.svg'],
});
