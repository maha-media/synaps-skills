import json, os, subprocess, sys, unittest
ROOT=os.path.dirname(os.path.dirname(__file__))
def frame(o):
 b=json.dumps(o).encode(); return b'Content-Length: '+str(len(b)).encode()+b'\r\n\r\n'+b
def parse(b):
 h,body=b.split(b'\r\n\r\n',1); n=int(h.split(b':',1)[1]); return json.loads(body[:n])
class ProtocolTest(unittest.TestCase):
 def test_initialize_and_invalid_tool_runtime(self):
  data=frame({'jsonrpc':'2.0','id':1,'method':'initialize'})+frame({'jsonrpc':'2.0','id':2,'method':'tool.call','params':{'name':'wrong','input':{}}})+frame({'jsonrpc':'2.0','id':3,'method':'shutdown'})
  p=subprocess.run([sys.executable,'main.py'],cwd=ROOT,input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
  chunks=p.stdout.split(b'Content-Length: ')[1:]; replies=[parse(b'Content-Length: '+x) for x in chunks]
  self.assertEqual(p.returncode,0); self.assertEqual(replies[0]['result']['capabilities']['tools'][0]['name'],'analyze_brand_palette'); self.assertEqual(replies[1]['error']['code'],-32602);self.assertEqual(replies[2]['id'],3)
