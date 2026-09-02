"""Vault-curator contracts and exact gateway subjects."""
import re as _re
TOOL_SUBJECTS={"audit_vault":"VAULT_AUDIT","inspect_vault_gap":"VAULT_GAP_INSPECT","propose_vault_patch":"VAULT_PATCH_PLAN","request_vault_patch_publish":"VAULT_PATCH_REQUEST","get_vault_patch_status":"VAULT_PATCH_STATUS","verify_vault_patch":"VAULT_PATCH_VERIFY","list_collections":"LIST_COLLECTIONS","list_uploads":"LIST_UPLOADS","read_upload":"READ_UPLOAD"}
def S(n=500):return {"type":"string","minLength":1,"maxLength":n}
def A(item,n=20):return {"type":"array","items":item,"minItems":1,"maxItems":n}
def O(props,required):return {"type":"object","additionalProperties":False,"properties":props,"required":required}
Q={"query":S(),"uploadIds":A(S(256)),"vault":{"type":"string","enum":["personal","instance","account"]},"minScore":{"type":"number"},"limit":{"type":"integer"}}
OBJECT_ID_PATTERN="^[0-9a-fA-F]{24}$"
CURSOR_MSG="cursor must be a 24-char hex ObjectId from a previous response's nextCursor \u2014 omit it on the first call"
CURSOR={"type":"string","minLength":24,"maxLength":24,"pattern":OBJECT_ID_PATTERN,"errorMessage":CURSOR_MSG}
TOOL_SCHEMAS={
"audit_vault":O(Q,["query"]),
"inspect_vault_gap":O({**Q,"recurrenceCount":{"type":"integer"},"sources":A({"type":"object"}),"safetySensitive":{"type":"boolean"},"conflictingSources":{"type":"boolean"}},["query"]),
"propose_vault_patch":O({"title":S(),"summary":S(10000),"facts":A(S(10000)),"aliases":A(S()),"sources":A({"type":"object"}),"target":{"type":"object"},"probeQueries":A(S(),10),"preconditions":A(S(),20)},["title","summary","facts","aliases","sources","target","probeQueries","preconditions"]),
"request_vault_patch_publish":O({"runId":S(128),"planHash":S(64)},["runId","planHash"]),"get_vault_patch_status":O({"runId":S(128),"limit":{"type":"integer"}},["runId"]),"verify_vault_patch":O({**Q,"minimumScore":{"type":"number"},"maximumRank":{"type":"integer"}},["query"]),
"list_collections":O({"limit":{"type":"integer"},"cursor":CURSOR},[]),
"list_uploads":O({"collectionId":S(),"status":{"type":"string","enum":["selected","inactive","active","error"]},"limit":{"type":"integer"},"cursor":CURSOR},[]),
"read_upload":O({"uploadId":S()},["uploadId"])}
D={"audit_vault":"Audit retrieval coverage for a query.","inspect_vault_gap":"Inspect a query-based vault gap.","propose_vault_patch":"Create a read-only patch plan.","request_vault_patch_publish":"Request publication (currently expected to be denied).","get_vault_patch_status":"Get a curation run status.","verify_vault_patch":"Verify retrieval using a query.","list_collections":"List knowledge vault collections for this institution. Personal vaults are not accessible. Omit cursor on the first call; to page, pass the nextCursor value returned by the previous call.","list_uploads":"List uploaded documents, optionally filtered by collection or status. Omit cursor on the first call; to page, pass the nextCursor value returned by the previous call.","read_upload":"Get detailed metadata for a specific upload including ingestion status."}
TOOL_SPECS=[{"name":n,"description":D[n],"input_schema":TOOL_SCHEMAS[n]} for n in TOOL_SUBJECTS]
class ValidationError(ValueError):pass
def validate_input(name,value):
 if name not in TOOL_SCHEMAS:raise ValidationError(f"unknown tool: {name}")
 if not isinstance(value,dict):raise ValidationError("tool input must be an object")
 s=TOOL_SCHEMAS[name]; unknown=sorted(set(value)-set(s["properties"])); missing=[k for k in s["required"] if k not in value]
 if unknown:raise ValidationError("unexpected argument(s): "+", ".join(unknown))
 if missing:raise ValidationError("missing required argument(s): "+", ".join(missing))
 def check(k,v,p):
  t=p["type"]
  if t=="string":
   if not isinstance(v,str) or not v.strip() or ("maxLength" in p and len(v)>p["maxLength"]) or ("minLength" in p and len(v)<p["minLength"]):raise ValidationError(p.get("errorMessage") or f"{k} must be a bounded non-empty string")
   if "enum" in p and v not in p["enum"]:raise ValidationError(f"{k} must be one of: {', '.join(p['enum'])}")
   if "pattern" in p and not _re.fullmatch(p["pattern"],v):raise ValidationError(p.get("errorMessage") or f"{k} must match pattern {p['pattern']}")
  if t=="object" and not isinstance(v,dict):raise ValidationError(f"{k} must be an object")
  if t=="array":
   if not isinstance(v,list) or not p["minItems"]<=len(v)<=p["maxItems"]:raise ValidationError(f"{k} must be a bounded non-empty array")
   for i,x in enumerate(v):check(f"{k}[{i}]",x,p["items"])
  if t=="boolean" and not isinstance(v,bool):raise ValidationError(f"{k} must be a boolean")
  if t=="integer" and (not isinstance(v,int) or isinstance(v,bool)):raise ValidationError(f"{k} must be an integer")
  if t=="number" and (not isinstance(v,(int,float)) or isinstance(v,bool)):raise ValidationError(f"{k} must be a number")
 for k,v in value.items():check(k,v,s["properties"][k])
 return value
