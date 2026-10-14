import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCfOpsTools } from "./cf-ops-tools.mjs";

const previousConnect=McpServer.prototype.connect;
if(typeof previousConnect!=="function") throw new Error("McpServer.connect is unavailable");

McpServer.prototype.connect=async function(...args){
  if(!this.__cfOpsPreloadRegistered){
    registerCfOpsTools(this,z);
    Object.defineProperty(this,"__cfOpsPreloadRegistered",{value:true,enumerable:false,configurable:false});
  }
  return previousConnect.apply(this,args);
};
