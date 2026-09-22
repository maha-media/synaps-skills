"""Small public synthetic fixture for future held-out work; not a benchmark."""
def diagnosis_fixture():
    return {"task": "Diagnose a synthetic failing parser test",
            "evidence": "The parser rejects an empty field; no actual system was inspected.",
            "hypotheses": [{"id": "h-local", "description": "Empty fields are rejected"},
                           {"id": "unicode/é", "description": "Unicode decoding differs"}],
            "checks": [{"id": "mandatory", "description": "LOCAL REQUIRED DESCRIPTION", "required": True},
                       {"id": "optional", "description": "Inspect the supplied parser assertion", "required": False}]}
