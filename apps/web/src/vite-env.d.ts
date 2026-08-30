/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AGENT_OS_API_BASE?: string;
  readonly VITE_AGENT_OS_DEMO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
