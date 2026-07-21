"""Stable public tool contracts, subjects, validation, and API routes."""

TOOL_ROUTES = {
    "audit_vault": "/api/v1/vault-curator/audits",
    "inspect_vault_gap": "/api/v1/vault-curator/gaps/inspect",
    "propose_vault_patch": "/api/v1/vault-curator/patches/propose",
    "request_vault_patch_publish": "/api/v1/vault-curator/patches/publish",
    "get_vault_patch_status": "/api/v1/vault-curator/patches/status",
    "verify_vault_patch": "/api/v1/vault-curator/patches/verify",
}


def _string(max_length=256):
    return {"type": "string", "minLength": 1, "maxLength": max_length}


def _object(properties, required):
    return {"type": "object", "additionalProperties": False,
            "properties": properties, "required": required}


_ID = _string(256)
TOOL_SCHEMAS = {
    "audit_vault": _object({"vault_id": _ID, "scope": _string(1024)}, ["vault_id"]),
    "inspect_vault_gap": _object({"vault_id": _ID, "gap_id": _ID}, ["vault_id", "gap_id"]),
    "propose_vault_patch": _object({
        "vault_id": _ID, "gap_id": _ID,
        "patch": {"type": "object", "minProperties": 1, "maxProperties": 100},
        "rationale": _string(10000),
    }, ["vault_id", "gap_id", "patch", "rationale"]),
    "request_vault_patch_publish": _object({"vault_id": _ID, "patch_id": _ID}, ["vault_id", "patch_id"]),
    "get_vault_patch_status": _object({"vault_id": _ID, "patch_id": _ID}, ["vault_id", "patch_id"]),
    "verify_vault_patch": _object({"vault_id": _ID, "patch_id": _ID}, ["vault_id", "patch_id"]),
}
_DESCRIPTIONS = {
    "audit_vault": "Audit a vault and return identified curation gaps.",
    "inspect_vault_gap": "Inspect one vault gap in detail.",
    "propose_vault_patch": "Submit a vault patch proposal for review; does not publish it.",
    "request_vault_patch_publish": "Request publication of an approved vault patch.",
    "get_vault_patch_status": "Get the current review or publication status of a vault patch.",
    "verify_vault_patch": "Verify the result of a published vault patch.",
}
TOOL_SPECS = [{"name": name, "description": _DESCRIPTIONS[name],
               "input_schema": TOOL_SCHEMAS[name]} for name in TOOL_ROUTES]


class ValidationError(ValueError):
    """Invalid tool arguments."""


def validate_input(name, value):
    """Validate the deliberately small JSON-schema subset used by these tools."""
    if name not in TOOL_SCHEMAS:
        raise ValidationError(f"unknown tool: {name}")
    if not isinstance(value, dict):
        raise ValidationError("tool input must be an object")
    schema = TOOL_SCHEMAS[name]
    unknown = sorted(set(value) - set(schema["properties"]))
    if unknown:
        raise ValidationError("unexpected argument(s): " + ", ".join(unknown))
    missing = [key for key in schema["required"] if key not in value]
    if missing:
        raise ValidationError("missing required argument(s): " + ", ".join(missing))
    for key, item in value.items():
        prop = schema["properties"][key]
        expected = prop["type"]
        if expected == "string":
            if not isinstance(item, str) or not item.strip():
                raise ValidationError(f"{key} must be a non-empty string")
            if len(item) > prop["maxLength"]:
                raise ValidationError(f"{key} exceeds maximum length")
        elif expected == "object":
            if not isinstance(item, dict) or not item:
                raise ValidationError(f"{key} must be a non-empty object")
            if len(item) > prop["maxProperties"]:
                raise ValidationError(f"{key} has too many properties")
    return value
