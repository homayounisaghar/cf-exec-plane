import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWhatsAppConversationTool } from "./whatsapp-ingress.mjs";

const previousConnect = McpServer.prototype.connect;
if (typeof previousConnect !== "function") {
  throw new Error("McpServer.connect is unavailable");
}

McpServer.prototype.connect = async function (...args) {
  if (!this.__whatsappPreloadRegistered) {
    registerWhatsAppConversationTool(this, z, {
      materialUpload: globalThis.__cfMaterialUpload,
      stageMaterialDownload: globalThis.__cfStageWhatsAppMaterialDownload,
    });
    Object.defineProperty(this, "__whatsappPreloadRegistered", {
      value: true,
      enumerable: false,
      configurable: false,
    });
  }
  return previousConnect.apply(this, args);
};
