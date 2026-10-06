import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWeChatConversationTool } from "./wechat-ingress.mjs";

const previousConnect=McpServer.prototype.connect;
if(typeof previousConnect!=="function") throw new Error("McpServer.connect is unavailable");

McpServer.prototype.connect=async function(...args){
  if(!this.__wechatPreloadRegistered){
    registerWeChatConversationTool(this,z,{materialUpload:globalThis.__cfMaterialUpload});
    Object.defineProperty(this,"__wechatPreloadRegistered",{value:true,enumerable:false,configurable:false});
  }
  return previousConnect.apply(this,args);
};
