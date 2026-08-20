import json,os,sys,unittest
from urllib import error
from unittest.mock import patch
sys.path.insert(0,os.path.join(os.path.dirname(__file__),"..","extensions"))
from vault_curator.client import *
from vault_curator.tools import *
class Response:
 def __init__(self,value,raw=False):self.value,self.raw=value,raw
 def __enter__(self):return self
 def __exit__(self,*a):pass
 def read(self,n):
  d=self.value if self.raw else json.dumps(self.value).encode();return d[:n]
class Tests(unittest.TestCase):
 @patch.dict(os.environ,{"PRIA_AGENT_TOOL_TOKEN":"token","PRIA_API_KEY":"ignore"},clear=True)
 def test_exact_envelope_path_and_result(self):
  seen={}
  def op(req,timeout):
   body=json.loads(req.data);seen.update(url=req.full_url,body=body,headers=dict(req.header_items()),timeout=timeout)
   return Response({"success":True,"callId":body["callId"],"result":{"ok":1}})
  self.assertEqual(PriaGatewayClient("https://pria.test",opener=op).call("VAULT_AUDIT",{"query":"q"}),{"ok":1})
  self.assertEqual(seen["url"],"https://pria.test/internal/agent-tool-call");self.assertEqual(set(seen["body"]),{"callId","subject","args"});self.assertEqual(seen["body"]["subject"],"VAULT_AUDIT");self.assertNotIn("ignore",json.dumps(seen))
 @patch.dict(os.environ,{"PRIA_AGENT_TOOL_TOKEN":"token"},clear=True)
 def test_envelope_validation(self):
  for response in ({}, {"success":False,"callId":"x","result":{}},{"success":True,"callId":"wrong","result":{}},{"success":True,"callId":"x"},[]):
   with self.subTest(response=response),self.assertRaises(GatewayError):PriaGatewayClient("https://x.test",opener=lambda *a,r=response,**kw:Response(r)).call("VAULT_AUDIT",{})
 @patch.dict(os.environ,{"PRIA_AGENT_TOOL_TOKEN":"token"},clear=True)
 def test_security_errors_bounds(self):
  for url in ("http://x.test","https://u@x.test","https://x.test/path","https://x.test?q=1"):
   with self.assertRaises(ValueError):PriaGatewayClient(url)
  def denied(req,timeout):raise error.HTTPError(req.full_url,403,"secret",{},None)
  with self.assertRaises(GatewayError) as c:PriaGatewayClient("https://x.test",opener=denied).call("VAULT_AUDIT",{})
  self.assertEqual(c.exception.as_dict()["status"],403);self.assertNotIn("secret",str(c.exception))
  with self.assertRaises(GatewayError):PriaGatewayClient("https://x.test",opener=lambda *a,**kw:Response(b"x"*(MAX_RESPONSE_BYTES+1),True)).call("VAULT_AUDIT",{})
 @patch.dict(os.environ,{"PRIA_API_KEY":"raw"},clear=True)
 def test_private_runtime_http_origin_is_allowed_but_public_http_is_denied(self):
  with patch.dict(os.environ,{"PRIA_AGENT_TOOL_TOKEN":"token"},clear=True):
   PriaGatewayClient("http://host.libvirt.internal:3080")
   PriaGatewayClient("http://127.0.0.1:3080")
   with self.assertRaisesRegex(ValueError,"restricted"): PriaGatewayClient("http://pria.example")
 def test_token_from_config_channel_without_env(self):
  with patch.dict(os.environ,{},clear=True):
   seen={}
   def opener(req,timeout):
    seen["auth"]=dict(req.header_items()).get("Authorization")
    class R:
     def __enter__(s):return s
     def __exit__(s,*a):pass
     def read(s,n):return json.dumps({"success":True,"callId":json.loads(req.data)["callId"],"result":{"ok":True}}).encode()
    return R()
   client=PriaGatewayClient("https://pria.test","cfg-token",opener=opener)
   client.call("VAULT_AUDIT",{"query":"x"})
   self.assertEqual(seen["auth"],"Bearer cfg-token")
 def test_token_required(self):
  with self.assertRaises(ValueError):PriaGatewayClient("https://x.test")
 def test_subjects_and_schemas(self):
  self.assertEqual(TOOL_SUBJECTS,{"audit_vault":"VAULT_AUDIT","inspect_vault_gap":"VAULT_GAP_INSPECT","propose_vault_patch":"VAULT_PATCH_PLAN","request_vault_patch_publish":"VAULT_PATCH_REQUEST","get_vault_patch_status":"VAULT_PATCH_STATUS","verify_vault_patch":"VAULT_PATCH_VERIFY","list_collections":"LIST_COLLECTIONS","list_uploads":"LIST_UPLOADS","read_upload":"READ_UPLOAD"})
  self.assertTrue(all("vault_id" not in s["properties"] for s in TOOL_SCHEMAS.values()));self.assertEqual(TOOL_SCHEMAS["request_vault_patch_publish"]["required"],["runId","planHash"])
 def test_process_extension_initialize_and_tool_call(self):
  import importlib.util, io, struct
  main_path=os.path.join(os.path.dirname(__file__),"..","extensions","main.py")
  spec=importlib.util.spec_from_file_location("vault_curator_main",main_path); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
  body=json.dumps({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"config":{"pria_base_url":"https://pria.test"}}}).encode()
  frame=b"Content-Length: "+str(len(body)).encode()+b"\r\n\r\n"+body
  self.assertEqual(mod.read_frame(io.BytesIO(frame))["method"],"initialize")
  out=io.BytesIO(); mod.write_frame(out,1,result={"protocol_version":1}); raw=out.getvalue(); self.assertIn(b'"protocol_version":1',raw)
 def test_validation(self):
  self.assertEqual(validate_input("audit_vault",{"query":"q"}),{"query":"q"})
  for bad in ({},{"query":" "},{"query":"q","vault_id":"v"},{"query":3}):
   with self.assertRaises(ValidationError):validate_input("audit_vault",bad)
  self.assertEqual(validate_input("list_collections",{}),{})
  self.assertEqual(validate_input("list_collections",{"vault":"instance"}),{"vault":"instance"})
  with self.assertRaises(ValidationError):validate_input("list_collections",{"vault":"invalid"})
  self.assertEqual(validate_input("list_uploads",{"collectionId":"c1"}),{"collectionId":"c1"})
  self.assertEqual(validate_input("list_uploads",{"status":"selected"}),{"status":"selected"})
  with self.assertRaises(ValidationError):validate_input("list_uploads",{"status":"deleted"})
  with self.assertRaises(ValidationError):validate_input("read_upload",{})
  self.assertEqual(validate_input("read_upload",{"uploadId":"u1"}),{"uploadId":"u1"})
if __name__=="__main__":unittest.main()
