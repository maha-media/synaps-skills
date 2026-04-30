import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VMCTL = ROOT / "scripts" / "vmctl.py"
MEMORY = ROOT / "scripts" / "memory.py"


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_plugin_manifest_declares_agent_min_version():
    manifest = json.loads((ROOT / ".synaps-plugin" / "plugin.json").read_text())

    assert manifest["name"] == "synaps-vm-automation"
    assert manifest["x-synaps-vm-agent-min-version"] == "0.1.0"


def test_vmctl_ip_parsing_and_version_compatibility(monkeypatch):
    vmctl = load_module(VMCTL, "vmctl_test")

    def fake_virsh(args):
        assert args == ["domifaddr", "win", "--source", "agent"]
        return " Name MAC Protocol Address\n vnet0 52:54 ipv4 192.168.122.44/24\n"

    monkeypatch.setattr(vmctl, "virsh", fake_virsh)

    assert vmctl._ip_candidates("win") == ["192.168.122.44"]
    assert vmctl._compatible("0.1.0") is True
    assert vmctl._compatible("0.0.9") is False
    assert vmctl._compatible(None) is None


def test_vmctl_revert_requires_confirmation():
    result = subprocess.run(
        [sys.executable, str(VMCTL), "snapshot-revert", "vm", "snap"],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 1
    body = json.loads(result.stderr)
    assert "rerun with --yes" in body["error"]["message"]


def test_memory_recall_handles_missing_velocirag(monkeypatch):
    memory = load_module(MEMORY, "memory_test")
    monkeypatch.setattr(memory.shutil, "which", lambda name: None)

    result = memory.recall(type("Args", (), {"query": "notepad"})())

    assert result["available"] is False
    assert result["results"] == []


def test_notepad_example_validates_against_agent_schema():
    try:
        import jsonschema
    except ImportError:
        return
    agent_root = Path(os.environ.get("SYNAPS_VM_AGENT_DEV_ROOT", "~/Projects/Maha-Media/synaps-vm-agent")).expanduser()
    schema_path = agent_root / "schema" / "plan-v0.schema.json"
    if not schema_path.exists():
        return
    schema = json.loads(schema_path.read_text())
    plan = json.loads((ROOT / "examples" / "notepad-plan.json").read_text())
    jsonschema.validate(plan, schema)
