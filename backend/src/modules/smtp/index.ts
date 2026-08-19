import { ModuleProvider, Modules } from "@medusajs/framework/utils"

import SmtpNotificationProviderService from "./service"

export default ModuleProvider(Modules.NOTIFICATION, {
  services: [SmtpNotificationProviderService],
})
