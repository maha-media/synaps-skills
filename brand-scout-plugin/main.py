#!/usr/bin/env python3
"""Content-Length JSON-RPC process entrypoint for Brand Scout."""
import json, sys
from brand_scout import analyze_brand_palette
TOOLS=[{"name":"analyze_brand_palette","description":"Safely fetch static HTTPS HTML and same-origin CSS, returning bounded colour source evidence for LLM interpretation; no rendering or primary/accent/background role classification.","input_schema":{"type":"object","properties":{"url":{"type":"string","description":"HTTPS page URL"}},"required":["url"]}}]
def read():
    h={}
    while True:
        line=sys.stdin.buffer.readline()
        if not line:return None
        if line in (b'\r\n',b'\n'):break
        k,sep,v=line.partition(b':')
        if sep:h[k.lower()]=v.strip()
    n=int(h.get(b'content-length',b'0'))
    return json.loads(sys.stdin.buffer.read(n)) if n>0 else None
def send(o):
    b=json.dumps(o,separators=(',',':')).encode(); sys.stdout.buffer.write(b'Content-Length: '+str(len(b)).encode()+b'\r\n\r\n'+b);sys.stdout.buffer.flush()
def main():
    while (m:=read()) is not None:
        mid=m.get('id'); method=m.get('method'); params=m.get('params') or {}
        if method=='initialize': send({'jsonrpc':'2.0','id':mid,'result':{'protocol_version':1,'capabilities':{'tools':TOOLS}}})
        elif method=='tool.call':
            inp=params.get('input',params.get('arguments',{})) or {}
            if params.get('name')!='analyze_brand_palette' or not isinstance(inp.get('url'),str): send({'jsonrpc':'2.0','id':mid,'error':{'code':-32602,'message':'analyze_brand_palette requires url'}})
            else: send({'jsonrpc':'2.0','id':mid,'result':{'content':json.dumps(analyze_brand_palette(inp['url']))}})
        elif method=='shutdown': send({'jsonrpc':'2.0','id':mid,'result':{}});break
        else: send({'jsonrpc':'2.0','id':mid,'error':{'code':-32601,'message':'Method not found'}})
if __name__=='__main__':main()
