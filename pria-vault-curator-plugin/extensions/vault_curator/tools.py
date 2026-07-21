"""Vault-curator contracts and exact gateway subjects."""
TOOL_SUBJECTS={"audit_vault":"VAULT_AUDIT","inspect_vault_gap":"VAULT_GAP_INSPECT","propose_vault_patch":"VAULT_PATCH_PLAN","request_vault_patch_publish":"VAULT_PATCH_REQUEST","get_vault_patch_status":"VAULT_PATCH_STATUS","verify_vault_patch":"VAULT_PATCH_VERIFY"}
def S(n=500):return {"type":"string","minLength":1,"maxLength":n}
def A(item,n=20):return {"type":"array","items":item,"minItems":1,"maxItems":n}
def O(props,required):return {"type":"object","additionalProperties":False,"properties":props,"required":required}
Q={"query":S(),"uploadIds":A(S(256)),"vault":{"type":"object"},"minScore":{"type":"number"},"limit":{"type":"integer"}}
TOOL_SCHEMAS={
"audit_vault":O(Q,["query"]),
"inspect_vault_gap":O({**Q,"recurrenceCount":{"type":"integer"},"sources":A({"type":"object"}),"safetySensitive":{"type":"boolean"},"conflictingSources":{"type":"boolean"}},["query"]),
"propose_vault_patch":O({"title":S(),"summary":S(10000),"facts":A(S(10000)),"aliases":A(S()),"sources":A({"type":"object"}),"target":{"type":"object"},"probeQueries":A(S(),10),"preconditions":A(S(),20)},["title","summary","facts","aliases","sources","target","probeQueries","preconditions"]),
"request_vault_patch_publish":O({"runId":S(256)},["runId"]),"get_vault_patch_status":O({"runId":S(256),"limit":{"type":"integer"}},["runId"]),"verify_vault_patch":O({**Q,"minimumScore":{"type":"number"},"maximumRank":{"type":"integer"}},["query"])}
D={"audit_vault":"Audit retrieval coverage for a query.","inspect_vault_gap":"Inspect a query-based vault gap.","propose_vault_patch":"Create a read-only patch plan.","request_vault_patch_publish":"Request publication (currently expected to be denied).","get_vault_patch_status":"Get a curation run status.","verify_vault_patch":"Verify retrieval using a query."}
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
  if t=="string" and (not isinstance(v,str) or not v.strip() or len(v)>p["maxLength"]):raise ValidationError(f"{k} must be a bounded non-empty string")
  if t=="object" and not isinstance(v,dict):raise ValidationError(f"{k} must be an object")
  if t=="array":
   if not isinstance(v,list) or not p["minItems"]<=len(v)<=p["maxItems"]:raise ValidationError(f"{k} must be a bounded non-empty array")
   for i,x in enumerate(v):check(f"{k}[{i}]",x,p["items"])
  if t=="boolean" and not isinstance(v,bool):raise ValidationError(f"{k} must be a boolean")
  if t=="integer" and (not isinstance(v,int) or isinstance(v,bool)):raise ValidationError(f"{k} must be an integer")
  if t=="number" and (not isinstance(v,(int,float)) or isinstance(v,bool)):raise ValidationError(f"{k} must be a number")
 for k,v in value.items():check(k,v,s["properties"][k])
 return value
