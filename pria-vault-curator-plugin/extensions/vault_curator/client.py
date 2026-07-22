"""Strict Pria agent-tool gateway client."""
import json, os, uuid
from urllib import error, parse, request
REQUEST_TIMEOUT_SECONDS=15
MAX_RESPONSE_BYTES=2*1024*1024
class GatewayError(RuntimeError):
 def __init__(self,code,message,*,status=None): super().__init__(message); self.code,self.status=code,status
 def as_dict(self):
  d={"code":self.code,"message":str(self)}
  if self.status is not None:d["status"]=self.status
  return d
class PriaGatewayClient:
 def __init__(self,base_url,token=None,*,opener=request.urlopen):
  if not isinstance(base_url,str) or not base_url.strip(): raise ValueError("pria_base_url is required")
  u=parse.urlsplit(base_url.strip())
  if u.scheme not in ("https","http") or not u.hostname or u.username or u.password: raise ValueError("pria_base_url must be an HTTPS origin (or loopback/private HTTP) without credentials")
  if u.scheme=="http" and not (u.hostname in ("localhost","127.0.0.1","::1","host.libvirt.internal") or u.hostname.endswith(".internal")): raise ValueError("HTTP pria_base_url is restricted to loopback/private runtime hosts")
  if u.path not in ("","/") or u.query or u.fragment: raise ValueError("pria_base_url must be an origin (no path, query, or fragment)")
  self.base_url=parse.urlunsplit((u.scheme,u.netloc,"","","")); self.token=(token or os.environ.get("PRIA_AGENT_TOOL_TOKEN") or "").strip(); self.opener=opener
  if not self.token: raise ValueError("PRIA_AGENT_TOOL_TOKEN is required")
 def call(self,subject,args):
  if not isinstance(subject,str) or not subject or not subject.replace("_","").isupper(): raise ValueError("invalid gateway subject")
  call_id=str(uuid.uuid4()); body=json.dumps({"callId":call_id,"subject":subject,"args":args},separators=(",",":")).encode()
  req=request.Request(self.base_url+"/internal/agent-tool-call",data=body,method="POST",headers={"Authorization":"Bearer "+self.token,"Content-Type":"application/json","Accept":"application/json"})
  try:
   with self.opener(req,timeout=REQUEST_TIMEOUT_SECONDS) as response: raw=response.read(MAX_RESPONSE_BYTES+1)
  except error.HTTPError as exc: raise GatewayError("upstream_http_error","Pria gateway rejected the request",status=exc.code) from exc
  except (error.URLError,TimeoutError,OSError) as exc: raise GatewayError("upstream_unavailable","Pria gateway is unavailable") from exc
  if len(raw)>MAX_RESPONSE_BYTES: raise GatewayError("response_too_large","Pria gateway response exceeded the size limit")
  try: value=json.loads(raw)
  except (UnicodeDecodeError,json.JSONDecodeError) as exc: raise GatewayError("invalid_upstream_response","Pria gateway returned invalid JSON") from exc
  if not isinstance(value,dict) or value.get("success") is not True or value.get("callId")!=call_id or "result" not in value: raise GatewayError("invalid_upstream_response","Pria gateway returned an invalid response envelope")
  return value["result"]
