import { ModuleProvider, Modules } from "@medusajs/framework/utils"

import OptimizedFileService from "./service"

export default ModuleProvider(Modules.FILE, {
  services: [OptimizedFileService],
})
