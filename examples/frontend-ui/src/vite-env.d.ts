/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USDC_MINT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
