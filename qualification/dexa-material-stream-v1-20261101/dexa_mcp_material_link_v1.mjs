// Pure provider-neutral MCP content adapter.
// resource_link is a referenced binary object, not inline bytes or model text.
// Only a verified authenticated tools/call reply may feed this function.
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
export function attachMcpMaterialLinks(structured,content){
 if(!obj(structured))throw new Error('MCP_STRUCTURED_RESULT_REQUIRED');
 if(!Array.isArray(content))return structured;
 const links=[];
 for(const item of content){
  if(item?.type!=='resource_link')continue;
  if(typeof item.uri!=='string'||item.uri.length<15||item.uri.length>4000||
    typeof item.name!=='string'||item.name.length<1||item.name.length>128)
   throw new Error('MCP_RESOURCE_LINK_INVALID');
  if(item.size!==undefined&&(!Number.isSafeInteger(item.size)||item.size<0))
   throw new Error('MCP_RESOURCE_LINK_SIZE_INVALID');
  if(item.mimeType!==undefined&&
   (typeof item.mimeType!=='string'||item.mimeType.length>128))
   throw new Error('MCP_RESOURCE_LINK_MIME_INVALID');
  if(links.length>=4)throw new Error('MCP_RESOURCE_LINK_COUNT_UNBOUNDED');
  links.push({uri:item.uri,name:item.name,
   ...(item.mimeType?{mimeType:item.mimeType}:{}),
   ...(item.size!==undefined?{size:item.size}:{})});
 }
 if(!links.length)return structured;
 if(Object.hasOwn(structured,'resource_links'))
  throw new Error('MCP_RESOURCE_LINK_CONFLICT');
 return {...structured,resource_links:links};
}
