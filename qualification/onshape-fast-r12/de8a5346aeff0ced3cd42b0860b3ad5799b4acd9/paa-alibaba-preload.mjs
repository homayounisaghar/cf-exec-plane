import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAlibabaConversationTool } from "./alibaba-ingress.mjs";

const previousConnect = McpServer.prototype.connect;
if (typeof previousConnect !== "function") {
  throw new Error("McpServer.connect is unavailable");
}

McpServer.prototype.connect = async function (...args) {
  if (!this.__alibabaPreloadRegistered) {
    registerAlibabaConversationTool(this, z, {
      materialUpload: globalThis.__cfMaterialUpload,
      stageMaterialDownload:
        globalThis.__cfStageAlibabaMaterialDownload
        || globalThis.__cfStageWhatsAppMaterialDownload
        || null,
    });
    Object.defineProperty(this, "__alibabaPreloadRegistered", {
      value: true,
      enumerable: false,
      configurable: false,
    });
  }
  return previousConnect.apply(this, args);
};
