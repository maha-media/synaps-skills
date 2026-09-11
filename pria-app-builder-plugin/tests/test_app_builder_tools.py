"""Schema + validation + gateway request-shaping tests for pria-app-builder.

Pins the CLIENT-side gate against the SERVER contract
(routes/services/appOperations.js + agentCapabilityRegistry.js in Pria). It is
not the security boundary (the gateway owns identity, project resolution and
the deployment grant) but it must never be laxer than the server, must never
let a shell string or a secret through, and must forward exactly the contract
fields under exactly the wire subject. No network: the urllib opener is
injected.
"""
import io
import json
import os
import sys
import unittest
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import app_builder_tools as abt  # noqa: E402
from app_builder_tools import (  # noqa: E402
    GatewayClient, MAX_ARGS_BYTES, TOOL_OPERATIONS, TOOL_SPECS, TOOL_SUBJECTS, ToolError,
    bounded_result, configured_client, dispatch, validate,
)

REV = "0123456789abcdef0123456789abcdef"
REV2 = "fedcba9876543210fedcba9876543210"
SID = "64b0c0ffee00000000000001"
LOCK = "a" * 64
BUILDER = {"node": "v22.11.0", "packageManager": "npm", "lockfileSha256": LOCK,
           "commands": [["npm", "ci"], ["npm", "test", "--", "--run"],
                        ["npm", "run", "build", "--", "--base", f"/64b0c0ffee00000000000009/r/{REV}/"]]}
SEAL = {"build": 1, "workdir": "worktree", "outputDir": "dist", "builder": BUILDER}
DEV_CMD = ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--strictPort"]
HEAD0 = {"revisionId": "", "generation": 0}
HEAD1 = {"revisionId": REV2, "generation": 4}
JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c"


class SchemaShape(unittest.TestCase):
    def test_tool_surface_is_closed_and_1_to_1_with_wire_subjects(self):
        self.assertEqual({s["name"] for s in TOOL_SPECS}, set(TOOL_SUBJECTS))
        # Gateway wire law: subjects are /^[A-Z_]+$/ (agentToolSubject.SUBJECTS);
        # the dotted names are registry metadata only.
        self.assertEqual(set(TOOL_SUBJECTS.values()), {
            "AGENTSPACE_APP_DEV_START", "AGENTSPACE_APP_DEV_STOP",
            "AGENTSPACE_APP_SERVICE_STATUS", "AGENTSPACE_APP_SERVICE_LOGS",
            "AGENTSPACE_APP_BUILD_SEAL",
            "AGENTSPACE_APP_RELEASE_START", "AGENTSPACE_APP_RELEASE_PUBLISH",
            "AGENTSPACE_APP_RELEASE_ROLLBACK", "AGENTSPACE_APP_RELEASE_STOP",
        })
        self.assertEqual(len(set(TOOL_SUBJECTS.values())), len(TOOL_SUBJECTS))
        for name, subject in TOOL_SUBJECTS.items():
            self.assertRegex(subject, r"^[A-Z_]+$")
            self.assertEqual(subject, "AGENTSPACE_" + TOOL_OPERATIONS[name].split(".", 1)[1].upper().replace(".", "_"))
            self.assertIn(subject, MAX_ARGS_BYTES)

    def test_args_byte_ceilings_mirror_the_registry(self):
        # agentCapabilityRegistry.js maxArgsBytes per subject (gateway → 413 above).
        self.assertEqual(MAX_ARGS_BYTES, {
            "AGENTSPACE_APP_DEV_START": 8192, "AGENTSPACE_APP_DEV_STOP": 1024,
            "AGENTSPACE_APP_SERVICE_STATUS": 1024, "AGENTSPACE_APP_SERVICE_LOGS": 1024,
            "AGENTSPACE_APP_BUILD_SEAL": 16384, "AGENTSPACE_APP_RELEASE_START": 2048,
            "AGENTSPACE_APP_RELEASE_PUBLISH": 2048, "AGENTSPACE_APP_RELEASE_ROLLBACK": 2048,
            "AGENTSPACE_APP_RELEASE_STOP": 1024,
        })

    def test_every_schema_is_closed(self):
        for spec in TOOL_SPECS:
            self.assertFalse(spec["input_schema"]["additionalProperties"], spec["name"])
            self.assertEqual(spec["input_schema"]["type"], "object", spec["name"])

    def test_no_schema_accepts_identity_or_address_fields(self):
        # The caller never chooses whose project, which VM, which IP/port/URL,
        # which edit session, nor (build.seal) the revision id itself.
        banned = {"project", "projectId", "institution", "user", "account", "vm", "vmId",
                  "ip", "privateIp", "port", "url", "upstream", "host", "sessionId", "editSessionId",
                  "subjectUserId", "environment", "publish", "artifactId"}
        for spec in TOOL_SPECS:
            props = set(spec["input_schema"]["properties"])
            self.assertEqual(props & banned, set(), spec["name"])
        self.assertNotIn("revisionId", TOOL_SPECS[4]["input_schema"]["properties"])  # app_build_seal: server-minted

    def test_schema_properties_match_what_the_server_reads(self):
        # appOperations.js handler `args.*` reads, per subject.
        expected = {
            "app_dev_start": {"workdir", "command", "readiness", "env"},
            "app_dev_stop": {"serviceId", "generation"},
            "app_service_status": {"serviceId"},
            "app_service_logs": {"serviceId", "cursor", "limit"},
            "app_build_seal": {"build", "allocateOnly", "workdir", "outputDir", "builder", "navigationPaths"},
            "app_release_start": {"revisionId"},
            "app_release_publish": {"revisionId", "expectedHead"},
            "app_release_rollback": {"revisionId", "expectedHead"},
            "app_release_stop": {"serviceId", "generation"},
        }
        for spec in TOOL_SPECS:
            self.assertEqual(set(spec["input_schema"]["properties"]), expected[spec["name"]], spec["name"])

    def test_descriptions_carry_the_key_guardrails(self):
        by = {s["name"]: s["description"] for s in TOOL_SPECS}
        self.assertIn("VERBATIM", by["app_dev_start"])
        self.assertIn("no shell", by["app_dev_start"])
        self.assertIn("PORT", by["app_dev_start"])
        self.assertIn("HEAD_CONFLICT", by["app_release_publish"])
        self.assertIn("RE-DECIDE", by["app_release_publish"])
        self.assertIn("never a loop", by["app_release_publish"])
        self.assertIn("NOT publish", by["app_release_start"])
        self.assertIn("SERVER-MINTED", by["app_build_seal"])
        self.assertIn("allocateOnly", by["app_build_seal"])
        self.assertIn("will not rebuild", by["app_release_rollback"])
        self.assertIn("never retry blindly", by["app_release_rollback"])
        self.assertIn("OPAQUE STRING", by["app_service_logs"])
        self.assertIn("does NOT report the published head", by["app_service_status"])


class ServerContractPin(unittest.TestCase):
    """Frozen verdicts of the SERVER's pure validators (appOperations.js) on a
    corpus. Law: the plugin may be stricter, never laxer. The deliberate
    stricter cases are enumerated so any drift is visible."""

    STRICTER_ON_PURPOSE = (
        # env: guest supervisor forwards only NODE_ENV/CI/VITE_* (others silently dropped)
        ("env", {"REACT_APP_X": "1"}), ("env", {"BROWSER": "none"}), ("env", {"PUBLIC_URL": "/"}),
        # expectedHead: server defaults missing keys; the plugin requires the observed pair explicitly
        ("expectedHead", {"revisionId": "", "generation": 1}), ("expectedHead", {"generation": 1}),
        ("expectedHead", {"revisionId": REV}), ("expectedHead", {}), ("expectedHead", {"revisionId": None, "generation": 0}),
    )

    @classmethod
    def setUpClass(cls):
        with open(os.path.join(HERE, "server_verdicts.fixture.json"), encoding="utf-8") as fh:
            cls.cases = json.load(fh)["cases"]

    @staticmethod
    def plugin_accepts(case):
        kind, value = case["kind"], case["value"]
        try:
            if kind == "command":
                abt._command(value, case["mode"])
            elif kind == "env":
                abt._env(value)
            elif kind == "relPath":
                abt._rel_path(value, "p", allow_empty=case["allowEmpty"])
            elif kind == "readiness":
                abt._readiness(value)
            elif kind == "expectedHead":
                abt._expected_head(value)
            elif kind == "serviceId":
                abt._service_id(value)
            elif kind == "cursor":
                abt._cursor(value)
            else:
                raise AssertionError(kind)
            return True
        except ToolError:
            return False

    def test_corpus_is_substantial(self):
        self.assertGreaterEqual(len(self.cases), 200)
        self.assertEqual({c["kind"] for c in self.cases},
                         {"command", "env", "relPath", "readiness", "expectedHead", "serviceId", "cursor"})

    def test_plugin_never_accepts_what_the_server_rejects(self):
        laxer = [c for c in self.cases if not c["server"] and self.plugin_accepts(c)]
        self.assertEqual(laxer, [])

    def test_plugin_accepts_everything_the_server_accepts_except_the_listed_exceptions(self):
        stricter = [(c["kind"], c["value"]) for c in self.cases if c["server"] and not self.plugin_accepts(c)]
        self.assertEqual(stricter, list(self.STRICTER_ON_PURPOSE))

    def test_command_verdicts_are_identical_to_the_server(self):
        for c in (c for c in self.cases if c["kind"] == "command"):
            self.assertEqual(self.plugin_accepts(c), c["server"], f"{c['mode']}: {c['value']!r}")


class DevStart(unittest.TestCase):
    def test_minimal_valid(self):
        args = validate("app_dev_start", {"workdir": "worktree", "command": DEV_CMD})
        self.assertEqual(args, {"workdir": "worktree", "command": DEV_CMD})

    def test_workdir_is_a_jailed_relative_path(self):
        for ok in ("worktree/app", "", "a-b_c.d/x"):
            validate("app_dev_start", {"workdir": ok, "command": DEV_CMD})
        for bad in ("/srv/ws/worktree", "worktree/../../etc", "..", ".", "a\\b", "a\x00b", "   ", "dist/", "./dist",
                    ".hidden", "a/.b", "a//b", "x" * 257, "/".join(["s"] * 17), 5, None):
            with self.assertRaises(ToolError, msg=repr(bad)):
                validate("app_dev_start", {"workdir": bad, "command": DEV_CMD})

    def test_command_is_a_server_vocabulary_vector_only(self):
        for bad in (
            "npm run dev",                                # string, not argv
            [],                                           # empty
            ["sh", "-c", "npm run dev"],                  # shell
            ["bash", "-lc", "npm run dev"],
            ["/usr/bin/npm", "run", "dev"],               # paths
            ["./node_modules/.bin/vite"],
            ["env", "FOO=1", "npm", "run", "dev"],
            ["npm", ""],                                  # empty arg
            ["npm", "run\n", "dev"],                      # control chars
            ["npm", 42],
            ["npm", "run", "dev"] + ["x"] * abt.MAX_COMMAND_TOKENS,   # too many tokens
            ["node", "-e", "require('child_process').exec('x')"],    # not a <file.js>
            ["node", "--eval", "1"], ["node", "-p", "1"], ["node"],
            ["npm", "run", "x" * (abt.MAX_TOKEN_LEN + 1)],
            ["npm", "run", "dev", "--port=${PORT}"],      # placeholders are not in the token charset
            ["npm", "run", "dev", "--", "$PORT"],
            ["pnpm", "dev"], ["yarn", "dev"],             # <pm> needs `run <script>`
            ["npm", "ci"], ["npm", "test"],               # build-only verbs
            ["vite", "build"], ["npx", "vite", "build"], ["vite", "preview"],
            ["corepack", "pnpm", "run", "dev"], ["npx", "serve"],
            ["npm", "run", "dev", "a;b"], ["npm", "run", "dev", "--", "a b"],
        ):
            with self.assertRaises(ToolError, msg=repr(bad)):
                validate("app_dev_start", {"workdir": "w", "command": bad})
        for ok in (["npm", "run", "dev"], ["pnpm", "run", "dev"], ["yarn", "run", "start"], ["npx", "vite"],
                   ["npx", "vite", "dev", "--strictPort"], ["vite"], ["vite", "serve", "--host", "127.0.0.1"],
                   ["node", "server.js"], ["node", "scripts/dev.mjs", "--port-from-env"], DEV_CMD):
            self.assertEqual(validate("app_dev_start", {"workdir": "w", "command": ok})["command"], ok)

    def test_readiness_object(self):
        self.assertEqual(validate("app_dev_start", {"workdir": "w", "command": DEV_CMD, "readiness": {"path": "/"}})["readiness"], {"path": "/"})
        self.assertEqual(validate("app_dev_start", {"workdir": "w", "command": DEV_CMD, "readiness": {"path": "/health", "timeoutMs": 90000}})["readiness"],
                         {"path": "/health", "timeoutMs": 90000})
        self.assertEqual(validate("app_dev_start", {"workdir": "w", "command": DEV_CMD, "readiness": {}})["readiness"], {})
        for bad in ({"path": "health"}, {"path": "http://x/"}, {"path": "/a b"}, {"path": "/../x"}, {"path": ""},
                    {"timeoutMs": 999}, {"timeoutMs": 180001}, {"timeoutMs": "5000"}, {"timeoutMs": True},
                    {"path": "/", "extra": 1}, "/", [], None):
            with self.assertRaises(ToolError, msg=repr(bad)):
                validate("app_dev_start", {"workdir": "w", "command": DEV_CMD, "readiness": bad})
        with self.assertRaises(ToolError):   # the old string form is not the contract
            validate("app_dev_start", {"workdir": "w", "command": DEV_CMD, "readinessPath": "/"})

    def test_env_public_only(self):
        ok = validate("app_dev_start", {"workdir": "w", "command": DEV_CMD,
                                        "env": {"VITE_APP_TITLE": "Demo", "NODE_ENV": "development", "CI": ""}})
        self.assertEqual(ok["env"], {"VITE_APP_TITLE": "Demo", "NODE_ENV": "development", "CI": ""})
        for bad in (
            {"DEV_PORT": "5173"}, {"PORT": "1"}, {"HOST": "0.0.0.0"}, {"REVISION_BASE": "/x/"},   # supervisor-owned
            {"PATH": "/tmp"}, {"HOME": "/"}, {"NODE_OPTIONS": "--require x"}, {"LD_PRELOAD": "x"},
            {"PRIA_AGENT_TOOL_TOKEN": "x"}, {"SYNAPS_BASE_DIR": "x"}, {"AWS_SECRET_ACCESS_KEY": "x"},
            {"NPM_TOKEN": "x"}, {"HTTP_PROXY": "http://x"},
            {"REACT_APP_X": "1"}, {"BROWSER": "none"}, {"PUBLIC_URL": "/"},                # dropped by the guest
            {"lower": "x"}, {"1ABC": "x"}, {"A-B": "x"}, {"VITE_a": "x"},                  # bad keys
            {"VITE_TOKEN": JWT}, {"VITE_KEY": "pria_" + "0" * 40},                        # secret-looking values
            {"VITE_PEM": "-----BEGIN RSA PRIVATE KEY-----"},
            {"VITE_X": 1}, {"VITE_X": "x" * (abt.MAX_ENV_VALUE + 1)}, {"VITE_X": "a\nb"}, "VITE_X=1",
        ):
            with self.assertRaises(ToolError, msg=repr(bad)):
                validate("app_dev_start", {"workdir": "w", "command": DEV_CMD, "env": bad})
        with self.assertRaises(ToolError):
            validate("app_dev_start", {"workdir": "w", "command": DEV_CMD,
                                       "env": {f"VITE_K{i}": "v" for i in range(abt.MAX_ENV_KEYS + 1)}})

    def test_unknown_fields_rejected(self):
        for extra in ({"port": 5173}, {"projectId": "x"}, {"editSessionId": REV}, {"readinessPath": "/"}):
            with self.assertRaises(ToolError, msg=repr(extra)):
                validate("app_dev_start", {"workdir": "w", "command": DEV_CMD, **extra})


class ServiceIdentity(unittest.TestCase):
    def test_stop_requires_exact_identity(self):
        for tool in ("app_dev_stop", "app_release_stop"):
            self.assertEqual(validate(tool, {"serviceId": SID, "generation": 3}), {"serviceId": SID, "generation": 3})
            self.assertEqual(validate(tool, {"serviceId": SID, "generation": 0})["generation"], 0)
            with self.assertRaises(ToolError): validate(tool, {"serviceId": SID})
            with self.assertRaises(ToolError): validate(tool, {"generation": 1})
            with self.assertRaises(ToolError): validate(tool, {"serviceId": SID, "generation": "3"})
            with self.assertRaises(ToolError): validate(tool, {"serviceId": SID, "generation": True})
            with self.assertRaises(ToolError): validate(tool, {"serviceId": SID, "generation": -1})
            with self.assertRaises(ToolError): validate(tool, {"serviceId": SID, "generation": 1.5})
            with self.assertRaises(ToolError): validate(tool, {"serviceId": SID, "generation": 2 ** 53 + 1})

    def test_service_id_is_the_24_hex_registry_id(self):
        # serviceIds are registry ObjectIds (serviceView.serviceId); the guest's
        # svc_… id and the vm/pid/port are never exposed nor accepted.
        for bad in ("svc_1", "svc_0123456789abcdef01234567", "", "a b", SID.upper(), SID[:-1], SID + "0", "x" * 24, 5, None):
            with self.assertRaises(ToolError, msg=repr(bad)):
                validate("app_service_status", {"serviceId": bad})
        self.assertEqual(validate("app_service_status", {"serviceId": SID}), {"serviceId": SID})
        with self.assertRaises(ToolError): validate("app_service_status", {})
        with self.assertRaises(ToolError): validate("app_service_status", {"serviceId": SID, "generation": 1})

    def test_logs_cursor_is_an_opaque_string_and_limit_is_bounded(self):
        self.assertEqual(validate("app_service_logs", {"serviceId": SID}), {"serviceId": SID})
        self.assertEqual(validate("app_service_logs", {"serviceId": SID, "cursor": "MTI", "limit": 200}),
                         {"serviceId": SID, "cursor": "MTI", "limit": 200})
        self.assertEqual(validate("app_service_logs", {"serviceId": SID, "cursor": "a-b_C9"})["cursor"], "a-b_C9")
        self.assertEqual(validate("app_service_logs", {"serviceId": SID, "cursor": "x" * 256})["cursor"], "x" * 256)
        for bad in ({"limit": 0}, {"limit": abt.MAX_LOG_LIMIT + 1}, {"limit": True}, {"limit": "10"},
                    {"cursor": 42}, {"cursor": -1}, {"cursor": True}, {"cursor": "a b"}, {"cursor": "c:17"},
                    {"cursor": ""}, {"cursor": "x" * 257}, {"cursor": {}}, {"cursor": None}):
            with self.assertRaises(ToolError, msg=repr(bad)):
                validate("app_service_logs", {"serviceId": SID, **bad})


class BuildSeal(unittest.TestCase):
    def test_allocate_only_takes_just_the_build_sequence(self):
        self.assertEqual(validate("app_build_seal", {"build": 1, "allocateOnly": True}), {"build": 1, "allocateOnly": True})
        self.assertEqual(validate("app_build_seal", {"build": 64, "allocateOnly": True})["build"], 64)
        for bad in ({"allocateOnly": True}, {"build": 0, "allocateOnly": True}, {"build": 65, "allocateOnly": True},
                    {"build": "1", "allocateOnly": True}, {"build": True, "allocateOnly": True}, {"build": 1, "allocateOnly": "yes"},
                    {"build": 1, "allocateOnly": True, "workdir": "w"}, {"build": 1, "allocateOnly": True, "revisionId": REV}):
            with self.assertRaises(ToolError, msg=repr(bad)):
                validate("app_build_seal", bad)

    def test_seal_is_valid_and_forwards_vectors(self):
        args = validate("app_build_seal", SEAL)
        self.assertEqual(args, {"build": 1, "workdir": "worktree", "outputDir": "dist", "builder": BUILDER})
        self.assertNotIn("allocateOnly", args)
        with self.assertRaises(ToolError):
            validate("app_build_seal", {**SEAL, "sourceDigest": "d" * 64})
        self.assertEqual(validate("app_build_seal", {**SEAL, "navigationPaths": ["/nested/", "/"]})["navigationPaths"], ["/", "/nested/"])
        self.assertEqual(validate("app_build_seal", {**SEAL, "workdir": ""})["workdir"], "")
        self.assertEqual(validate("app_build_seal", {**SEAL, "allocateOnly": False})["build"], 1)

    def test_seal_requires_workdir_outputdir_builder(self):
        for missing in ("workdir", "outputDir", "builder"):
            payload = dict(SEAL); del payload[missing]
            with self.assertRaises(ToolError, msg=missing):
                validate("app_build_seal", payload)
        with self.assertRaises(ToolError):
            validate("app_build_seal", {**SEAL, "revisionId": REV})   # server-minted, never caller-chosen
        for bad in ("x" * 39, "g" * 40, "C" * 40, 5):
            with self.assertRaises(ToolError, msg=repr(bad)):
                validate("app_build_seal", {**SEAL, "sourceDigest": bad})

    def test_output_dir_must_be_a_relative_subdirectory(self):
        for bad in ("/ws/dist", ".", "", "./", "./dist", "../dist", "dist/..", "dist\\x", "dist/", ".out"):
            with self.assertRaises(ToolError, msg=repr(bad)):
                validate("app_build_seal", {**SEAL, "outputDir": bad})
        self.assertEqual(validate("app_build_seal", {**SEAL, "outputDir": "build/out"})["outputDir"], "build/out")

    def test_builder_provenance_is_exact(self):
        def with_builder(**over):
            b = dict(BUILDER); b.update(over); return b
        for bad in (
            with_builder(node="22"), with_builder(node="latest"), with_builder(node="v" + "1" * 70),
            with_builder(packageManager="bun"), with_builder(packageManager="npm@10.9.0"), with_builder(packageManager="npm@latest"),
            with_builder(lockfileSha256="abc"), with_builder(lockfileSha256=LOCK.upper()), with_builder(lockfileSha256=""),
            with_builder(commands=[]), with_builder(commands=["npm ci"]),                  # strings are not vectors
            with_builder(commands=[["npm", "ci;", "rm", "-rf", "/"]]), with_builder(commands=[["npm", "ci", "&&", "npm", "run", "build"]]),
            with_builder(commands=[["sh", "-c", "npm run build"]]), with_builder(commands=[["bash", "build.sh"]]),
            with_builder(commands=[["./build.sh"]]), with_builder(commands=[["npm", "ci", "$(cat x)"]]),
            with_builder(commands=[["node", "-e", "1"]]), with_builder(commands=[["node", "--print", "1"]]),
            with_builder(commands=[["npm", "run", "build", "--", "--base", "$REVISION_BASE"]]),
            with_builder(commands=[["vite", "dev"]]), with_builder(commands=[["npx", "vite"]]),  # dev-only forms
            with_builder(commands=[["npm", "ci"]] * (abt.MAX_COMMANDS + 1)),
            with_builder(extra="x"), {"node": "v22.0.0"},
        ):
            with self.assertRaises(ToolError, msg=repr(bad)):
                validate("app_build_seal", {**SEAL, "builder": bad})
        missing = dict(BUILDER); del missing["lockfileSha256"]
        with self.assertRaises(ToolError):
            validate("app_build_seal", {**SEAL, "builder": missing})
        ok = validate("app_build_seal", {**SEAL, "builder": with_builder(
            packageManager="pnpm", node="22.11.0",
            commands=[["pnpm", "install", "--frozen-lockfile"], ["pnpm", "test"], ["pnpm", "run", "build", "--", "--base", "/p/r/x/"],
                      ["npx", "vite", "build"], ["vite", "build", "--mode", "production"], ["node", "scripts/postbuild.mjs"]])})
        self.assertEqual(len(ok["builder"]["commands"]), 6)


class Release(unittest.TestCase):
    def test_start_takes_only_retained_revision(self):
        self.assertEqual(validate("app_release_start", {"revisionId": REV}), {"revisionId": REV})
        for bad in ({"revisionId": REV, "workdir": "worktree/dist"}, {"revisionId": "nope"}, {"artifactId": SID}):
            with self.assertRaises(ToolError): validate("app_release_start", bad)

    def test_publish_requires_expected_head_object(self):
        self.assertEqual(validate("app_release_publish", {"revisionId": REV, "expectedHead": HEAD1}),
                         {"revisionId": REV, "expectedHead": HEAD1})
        self.assertEqual(validate("app_release_publish", {"revisionId": REV, "expectedHead": HEAD0})["expectedHead"], HEAD0)
        # idempotent re-publish of the current head is a legitimate server call (alreadyPublished)
        self.assertEqual(validate("app_release_publish", {"revisionId": REV, "expectedHead": {"revisionId": REV, "generation": 2}})["revisionId"], REV)
        for bad in (
            None, REV2, "", "latest", 3, [],                                     # bare/absent forms are never the contract
            {}, {"revisionId": REV2}, {"generation": 4},                         # observed pair must be explicit
            {"revisionId": None, "generation": 0}, {"revisionId": "", "generation": 1},
            {"revisionId": REV2.upper(), "generation": 4}, {"revisionId": REV2, "generation": -1},
            {"revisionId": REV2, "generation": "4"}, {"revisionId": REV2, "generation": True},
            {"revisionId": REV2, "generation": 4, "publishedAt": "2026-09-11T00:00:00Z"},   # pass only the pair
        ):
            with self.assertRaises(ToolError, msg=repr(bad)):
                validate("app_release_publish", {"revisionId": REV, "expectedHead": bad})
        with self.assertRaises(ToolError): validate("app_release_publish", {"revisionId": REV})   # omitted
        with self.assertRaises(ToolError): validate("app_release_publish", {"revisionId": REV, "expectedHead": HEAD0, "force": True})

    def test_rollback_takes_the_same_expected_head_object(self):
        self.assertEqual(validate("app_release_rollback", {"revisionId": REV2, "expectedHead": {"revisionId": REV, "generation": 5}}),
                         {"revisionId": REV2, "expectedHead": {"revisionId": REV, "generation": 5}})
        with self.assertRaises(ToolError): validate("app_release_rollback", {"revisionId": REV2})
        with self.assertRaises(ToolError): validate("app_release_rollback", {"revisionId": REV2, "expectedHead": REV})

    def test_unknown_tool_and_non_object(self):
        with self.assertRaises(ToolError): validate("nope", {})
        with self.assertRaises(ToolError): validate("app_service_status", "x")
        with self.assertRaises(ToolError): validate("app_service_status", None)

    def test_args_size_is_capped_per_subject(self):
        # 32 VITE_ keys × 512-char values ≈ 17 KB > dev.start's 8192 → refused before the network.
        env = {f"VITE_K{i:02d}": "v" * abt.MAX_ENV_VALUE for i in range(abt.MAX_ENV_KEYS)}
        with self.assertRaises(ToolError) as ctx:
            validate("app_dev_start", {"workdir": "w", "command": DEV_CMD, "env": env})
        self.assertIn("8192", str(ctx.exception))
        # the same payload fits the build.seal ceiling only if under 16384 — sanity: a normal seal is far below
        self.assertLess(len(json.dumps(validate("app_build_seal", SEAL), separators=(",", ":"))), 1024)


# ── gateway request shaping ──────────────────────────────────────────────────

class Resp:
    def __init__(self, body): self._body = body if isinstance(body, bytes) else json.dumps(body).encode()
    def read(self, n=-1): return self._body if n is None or n < 0 else self._body[:n]
    def close(self): pass


def http_error(status, body):
    return urllib.error.HTTPError(url="http://gw/x", code=status, msg="err", hdrs={},  # type: ignore[arg-type]
                                  fp=io.BytesIO(json.dumps(body).encode()))


class Recorder:
    def __init__(self, responses):
        self.responses, self.calls = list(responses), []

    def __call__(self, req, timeout=None):
        self.calls.append((req, timeout))
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


class Client(unittest.TestCase):
    def test_refuses_without_token(self):
        with self.assertRaises(ToolError): GatewayClient("", "https://x")
        with self.assertRaises(ToolError): configured_client({}, environ={})

    def test_token_from_env_beats_config_and_base_from_config(self):
        c = configured_client({"pria_agent_tool_token": "cfg", "pria_api_base": "http://host.libvirt.internal:3080/"},
                              environ={"PRIA_AGENT_TOOL_TOKEN": "envtok"})
        self.assertEqual(c.token, "envtok")
        self.assertEqual(c.base_url, "http://host.libvirt.internal:3080")
        c2 = configured_client({"pria_agent_tool_token": " cfg "}, environ={})
        self.assertEqual(c2.token, "cfg")
        self.assertEqual(c2.base_url, abt.DEFAULT_BASE)

    def test_posts_wire_subject_and_args_with_bearer(self):
        rec = Recorder([Resp({"success": True, "callId": "c1", "result": {
            "ok": True, "serviceId": SID, "generation": 1, "status": "starting",
            "previewUrl": "https://sites/p/d/cap/", "previewPath": "p/d/cap/", "previewExpiresAt": "2026-09-11T00:15:00.000Z"}})])
        out = GatewayClient("tok", "https://pria.example/", rec).call("AGENTSPACE_APP_DEV_START",
                                                                       {"workdir": "w", "command": DEV_CMD})
        req, timeout = rec.calls[0]
        self.assertEqual(req.full_url, "https://pria.example/internal/agent-tool-call")
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(req.get_header("Authorization"), "Bearer tok")
        self.assertEqual(req.get_header("Content-type"), "application/json")
        body = json.loads(req.data.decode())
        self.assertEqual(body, {"subject": "AGENTSPACE_APP_DEV_START", "args": {"workdir": "w", "command": DEV_CMD}})
        self.assertEqual(timeout, abt.SUBJECT_TIMEOUTS["AGENTSPACE_APP_DEV_START"])
        self.assertEqual(out["previewUrl"], "https://sites/p/d/cap/")
        self.assertEqual(out["previewExpiresAt"], "2026-09-11T00:15:00.000Z")

    def test_default_timeout_for_cheap_subjects(self):
        rec = Recorder([Resp({"success": True, "result": {"ok": True, "status": "ready"}})])
        GatewayClient("tok", "https://x", rec).call("AGENTSPACE_APP_SERVICE_STATUS", {"serviceId": SID})
        self.assertEqual(rec.calls[0][1], abt.DEFAULT_TIMEOUT)

    def test_refuses_unknown_or_dotted_subject(self):
        rec = Recorder([])
        for subject in ("SEARCH_KNOWLEDGE", "agentspace.app.dev.start", "PROXY_CALL"):
            with self.assertRaises(ToolError, msg=subject):
                GatewayClient("tok", "https://x", rec).call(subject, {})
        self.assertEqual(rec.calls, [])

    def test_http_error_surfaces_decision_and_hint_never_token(self):
        rec = Recorder([http_error(403, {"success": False, "decision": "denied_subject"})])
        with self.assertRaises(ToolError) as ctx:
            GatewayClient("secret-token-value", "https://x", rec).call("AGENTSPACE_APP_RELEASE_PUBLISH", {})
        self.assertIn("403", str(ctx.exception))
        self.assertIn("denied_subject", str(ctx.exception))
        self.assertIn("not granted", str(ctx.exception))
        self.assertNotIn("secret-token-value", str(ctx.exception))

    def test_handler_error_kind_is_surfaced_with_hint(self):
        rec = Recorder([http_error(400, {"success": False, "decision": "handler_error", "error_kind": 400})])
        with self.assertRaises(ToolError) as ctx:
            GatewayClient("t", "https://x", rec).call("AGENTSPACE_APP_RELEASE_PUBLISH", {})
        self.assertIn("handler_error", str(ctx.exception))
        self.assertIn("error_kind=400", str(ctx.exception))
        self.assertIn("APP_OP_INVALID", str(ctx.exception))
        rec = Recorder([http_error(413, {"success": False, "decision": "denied_allowlist"})])
        with self.assertRaises(ToolError) as ctx:
            GatewayClient("t", "https://x", rec).call("AGENTSPACE_APP_BUILD_SEAL", {})
        self.assertIn("byte limit", str(ctx.exception))

    def test_network_error_is_generic(self):
        rec = Recorder([urllib.error.URLError("http://internal-host:3080 refused")])
        with self.assertRaises(ToolError) as ctx:
            GatewayClient("t", "https://x", rec).call("AGENTSPACE_APP_SERVICE_STATUS", {})
        self.assertNotIn("internal-host", str(ctx.exception))

    def test_denied_and_malformed_bodies_raise(self):
        with self.assertRaises(ToolError):
            GatewayClient("t", "https://x", Recorder([Resp({"success": False, "decision": "rate_limited"})])).call("AGENTSPACE_APP_SERVICE_STATUS", {})
        with self.assertRaises(ToolError):
            GatewayClient("t", "https://x", Recorder([Resp(b"<html>")])).call("AGENTSPACE_APP_SERVICE_STATUS", {})
        with self.assertRaises(ToolError):
            GatewayClient("t", "https://x", Recorder([Resp(b"[]")])).call("AGENTSPACE_APP_SERVICE_STATUS", {})
        self.assertEqual(GatewayClient("t", "https://x", Recorder([Resp({"success": True})])).call("AGENTSPACE_APP_SERVICE_STATUS", {}), {})

    def test_typed_ok_false_results_pass_through_for_the_model(self):
        # HEAD_CONFLICT etc. are success:true envelopes with {ok:false, code, current}: the model must see them.
        conflict = {"ok": False, "code": "HEAD_CONFLICT", "current": {"revisionId": REV2, "generation": 7, "publishedAt": "2026-09-11T00:00:00.000Z"}}
        out = GatewayClient("t", "https://x", Recorder([Resp({"success": True, "result": conflict})])).call(
            "AGENTSPACE_APP_RELEASE_PUBLISH", {"revisionId": REV, "expectedHead": HEAD0})
        self.assertEqual(out, conflict)


class Dispatch(unittest.TestCase):
    def test_dispatch_validates_then_forwards_normalised_args(self):
        rec = Recorder([Resp({"success": True, "result": {"ok": True, "serviceId": SID, "generation": 1, "source": "store",
                                                          "entries": [], "next": None, "dropped": 0}})])
        client = GatewayClient("t", "https://x", rec)
        content = dispatch("app_service_logs", {"serviceId": SID, "limit": 50}, {}, client=client)
        self.assertEqual(json.loads(content)["entries"], [])
        self.assertIsNone(json.loads(content)["next"])
        self.assertEqual(json.loads(rec.calls[0][0].data.decode()),
                         {"subject": "AGENTSPACE_APP_SERVICE_LOGS", "args": {"serviceId": SID, "limit": 50}})

    def test_dispatch_publish_sends_expected_head_object(self):
        rec = Recorder([Resp({"success": True, "result": {"ok": True, "action": "publish",
                                                          "publishedHead": {"revisionId": REV, "generation": 5, "publishedAt": "2026-09-11T00:00:00.000Z"},
                                                          "serviceId": SID, "url": "https://sites/p/", "receipt": {"applied": True, "reason": None}}})])
        content = dispatch("app_release_publish", {"revisionId": REV, "expectedHead": HEAD1}, {}, client=GatewayClient("t", "https://x", rec))
        self.assertEqual(json.loads(rec.calls[0][0].data.decode()),
                         {"subject": "AGENTSPACE_APP_RELEASE_PUBLISH", "args": {"revisionId": REV, "expectedHead": HEAD1}})
        self.assertEqual(json.loads(content)["publishedHead"]["generation"], 5)

    def test_dispatch_rejects_before_any_network(self):
        rec = Recorder([])
        with self.assertRaises(ToolError):
            dispatch("app_dev_start", {"workdir": "w", "command": ["sh", "-c", "x"]}, {}, client=GatewayClient("t", "https://x", rec))
        with self.assertRaises(ToolError):
            dispatch("app_release_publish", {"revisionId": REV, "expectedHead": REV2}, {}, client=GatewayClient("t", "https://x", rec))
        self.assertEqual(rec.calls, [])

    def test_output_is_bounded_and_redacted(self):
        big = {"entries": [{"seq": i, "line": "x" * 1000} for i in range(600)]}
        out = json.loads(bounded_result(big))
        self.assertTrue(out["truncated"])
        self.assertLessEqual(len(bounded_result(big).encode()), abt.MAX_RESULT_BYTES)
        self.assertIn("resultBytes", out)
        leaked = json.loads(bounded_result({"line": f"Authorization: Bearer {JWT}", "previewUrl": "https://s/p/d/v3dcap/"}))
        self.assertNotIn(JWT, leaked["line"])
        self.assertEqual(leaked["previewUrl"], "https://s/p/d/v3dcap/")
        self.assertEqual(json.loads(bounded_result("scalar")), {"value": "scalar"})


if __name__ == "__main__":
    unittest.main()
