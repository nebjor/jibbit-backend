import { ModuleProvider, Modules } from "@medusajs/framework/utils"

import OptimizedFileService from "./service"

/**
 * File-Provider "optimized-file": lokale Ablage wie @medusajs/file-local,
 * aber Bilder werden vor dem Speichern verkleinert und neu kodiert
 * (Vorgabe: max. 2000 px, AVIF). Details und Grundsaetze: ./service.ts
 */
export default ModuleProvider(Modules.FILE, {
  services: [OptimizedFileService],
})
