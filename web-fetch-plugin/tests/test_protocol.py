import json
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(__file__))

def frame(obj):
    data = json.dumps(obj).encode()
    return b"Content-Length: " + str(len(data)).encode() + b"\r\n\r\n" + data

def parse_frames(data):
    messages = []
    while data:
        head, data = data.split(b"\r\n\r\n", 1)
        length = int(head.split(b":", 1)[1].strip())
        body, data = data[:length], data[length:]
        messages.append(json.loads(body))
    return messages

class ProtocolTests(unittest.TestCase):
    def test_initialize_unknown_and_shutdown_are_content_length_framed(self):
        requests = b"".join([
            frame({"jsonrpc":"2.0", "id":1, "method":"initialize"}),
            frame({"jsonrpc":"2.0", "id":2, "method":"nope"}),
            frame({"jsonrpc":"2.0", "id":3, "method":"shutdown"}),
        ])
        run = subprocess.run([sys.executable, "main.py"], cwd=ROOT, input=requests,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
        self.assertEqual(run.returncode, 0, run.stderr.decode())
        replies = parse_frames(run.stdout)
        self.assertEqual(replies[0]["result"]["protocol_version"], 1)
        self.assertEqual(replies[0]["result"]["capabilities"]["tools"][0]["name"], "fetch_web_page")
        self.assertEqual(replies[1]["error"]["code"], -32601)
        self.assertEqual(replies[2]["result"], {})

    def test_bad_tool_arguments_do_not_attempt_network(self):
        request = frame({"jsonrpc":"2.0", "id":1, "method":"tool.call", "params":{"name":"fetch_web_page", "input":{}}})
        run = subprocess.run([sys.executable, "main.py"], cwd=ROOT, input=request,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
        self.assertEqual(parse_frames(run.stdout)[0]["error"]["code"], -32602)
