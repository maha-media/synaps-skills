import socket, unittest
from unittest.mock import patch
from brand_scout import FetchError, analyze_brand_palette, extract_colors, validate_url, vetted_addresses

PUBLIC=[(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34',443))]
class TestSafety(unittest.TestCase):
    def test_https_and_authority_rules(self):
        for url in ('http://example.com','https://u@example.com','https://example.com:444/x','https:///x'):
            with self.assertRaises(FetchError): validate_url(url)
        self.assertEqual(validate_url('https://Example.com/a')[1], 'example.com')
    def test_blocks_every_non_public_category(self):
        for ip in ('127.0.0.1','10.0.0.1','169.254.1.1','224.0.0.1','240.0.0.1','0.0.0.0','::1','fc00::1','fe80::1','ff00::1','::'):
            resolver=lambda *a, ip=ip: [(socket.AF_INET6 if ':' in ip else socket.AF_INET,socket.SOCK_STREAM,6,'',(ip,443))]
            with self.assertRaises(FetchError, msg=ip): vetted_addresses('x.test',resolver)
    def test_public_dns_is_accepted(self): self.assertEqual(vetted_addresses('example.com',lambda *a: PUBLIC),['93.184.216.34'])

    def test_redirect_destination_is_revalidated_with_mocked_network(self):
        import brand_scout
        class FakeResponse:
            status=302
            headers={}
            def getheader(self, name): return 'https://127.0.0.1/secret' if name == 'Location' else None
        class FakeConnection:
            def __init__(self, *args): pass
            def request(self, *args, **kwargs): pass
            def getresponse(self): return FakeResponse()
            def close(self): pass
        with patch.object(brand_scout, '_PinnedHTTPSConnection', FakeConnection), patch.object(brand_scout, 'vetted_addresses', side_effect=lambda host, resolver: ['93.184.216.34'] if host == 'example.com' else (_ for _ in ()).throw(FetchError('DNS resolved to a non-public address'))):
            with self.assertRaises(FetchError): brand_scout.fetch_https('https://example.com/', brand_scout.HTML_CAP)

class R:
    def __init__(self,url,body): self.url=url; self.body=body
class TestExtraction(unittest.TestCase):
    def test_returns_static_normalized_evidence_without_role_claims(self):
        html=b'''<html><head><style>:root { --bg: #123; --accent: hsl(0, 100%, 50%); --ink: rgba(1,2,3,0) } body { background-color: var(--bg); color: rgb(18, 52, 86) } .cta { background: var(--accent) }</style><link rel="stylesheet" href="/site.css"></head><body style="color: #abcdef"><svg fill="#0f0" stroke="transparent"/></body></html>'''
        def fetch(url,cap):
            return R('https://example.com/' if url.endswith('/') else url, html if url.endswith('/') else b'.button { color: #FF0000 }')
        out=analyze_brand_palette('https://example.com/',fetch)
        self.assertFalse(out['rendered'])
        self.assertEqual(set(out), {'observations', 'design_tokens', 'declarations', 'warnings', 'rendered'})
        self.assertNotIn('primary', out); self.assertNotIn('accent', out); self.assertNotIn('background', out)
        tokens={item['name']: item for item in out['design_tokens']}
        self.assertEqual(tokens['--bg']['colors'], ['#112233'])
        self.assertEqual(tokens['--accent']['colors'], ['#FF0000'])
        body=[item for item in out['declarations'] if item['property'] == 'background-color']
        self.assertEqual(body[0]['value'], 'var(--bg)')
        self.assertEqual(body[0]['colors'], ['#112233'])
        self.assertTrue(any(item['color'] == '#112233' and item['property'] == 'background-color' for item in out['observations']))
        self.assertNotIn('#010203',str(out))
    def test_cross_origin_css_not_fetched(self):
        calls=[]
        def fetch(url,cap):
            calls.append(url); return R(url,b'<link rel="stylesheet" href="https://evil.example/a.css"><style>body{background:#fff}</style>')
        out=analyze_brand_palette('https://good.example/',fetch)
        self.assertEqual(calls,['https://good.example/']); self.assertIn('skipped cross-origin stylesheet',out['warnings'])
    def test_color_forms_and_transparency(self):
        self.assertEqual(extract_colors('#abc #11223344 rgb(100%,0%,0%) hsl(240,100%,50%)',{}),['#AABBCC','#112233','#FF0000','#0000FF'])
        self.assertEqual(extract_colors('rgba(1,2,3,0) #abcd transparent',{}),[])
    def test_fetch_failure_is_structured(self):
        out=analyze_brand_palette('http://bad.example')
        self.assertFalse(out['rendered']); self.assertEqual(out['observations'], [])
        self.assertEqual(out['design_tokens'], []); self.assertEqual(out['declarations'], [])
