#!/usr/bin/env python3
"""Read-only Solana release preflight inventory.

This helper inspects local repository metadata and derives public keys through
`solana-keygen` when available. It never prints keypair contents, contacts an
RPC endpoint, signs a transaction, builds code, or mutates the repository.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python < 3.11
    tomllib = None  # type: ignore[assignment]


VERSION = "1.0.0"
PUBKEY_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
DECLARE_ID_RE = re.compile(r'declare_id!\s*\(\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"\s*\)')
SEVERITY_ORDER = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "INFO": 4}


@dataclass(frozen=True)
class Finding:
    severity: str
    code: str
    message: str
    evidence: str | None = None


def run_command(args: list[str], cwd: Path, timeout: int = 5) -> tuple[int, str]:
    try:
        result = subprocess.run(
            args,
            cwd=cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
            env={**os.environ, "NO_COLOR": "1"},
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return 127, ""
    return result.returncode, result.stdout.strip()


def first_line(value: str) -> str:
    return value.splitlines()[0].strip() if value.strip() else ""


def last_line(value: str) -> str:
    return value.splitlines()[-1].strip() if value.strip() else ""


def safe_relative(path: Path, root: Path) -> str:
    try:
        return str(path.resolve().relative_to(root.resolve()))
    except ValueError:
        return path.name


def normalize_program_name(value: str) -> str:
    return value.strip().replace("-", "_")


def valid_pubkey(value: Any) -> bool:
    return isinstance(value, str) and bool(PUBKEY_RE.fullmatch(value.strip()))


def redacted_cluster(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    value = value.strip()
    if "://" not in value:
        return value
    parsed = urlsplit(value)
    host = parsed.hostname or "custom"
    port = f":{parsed.port}" if parsed.port else ""
    return f"<custom-rpc:{host}{port}>"


def read_toml(path: Path, findings: list[Finding]) -> dict[str, Any]:
    if tomllib is None:
        findings.append(
            Finding("MEDIUM", "TOML_UNAVAILABLE", "Python 3.11+ is required to parse TOML files.")
        )
        return {}
    try:
        with path.open("rb") as handle:
            data = tomllib.load(handle)
        return data if isinstance(data, dict) else {}
    except Exception as exc:  # noqa: BLE001 - report malformed project input
        findings.append(
            Finding(
                "HIGH",
                "TOML_PARSE_FAILED",
                f"Could not parse {path.name}.",
                f"{type(exc).__name__}: {exc}",
            )
        )
        return {}


def inspect_git(root: Path, findings: list[Finding]) -> dict[str, Any]:
    code, inside = run_command(["git", "rev-parse", "--is-inside-work-tree"], root)
    if code != 0 or inside != "true":
        findings.append(Finding("MEDIUM", "NOT_GIT_REPO", "Repository is not under Git provenance."))
        return {"is_repo": False}

    _, commit = run_command(["git", "rev-parse", "--verify", "HEAD"], root)
    _, branch = run_command(["git", "branch", "--show-current"], root)
    _, status_output = run_command(
        ["git", "status", "--porcelain=v1", "--untracked-files=no"], root
    )
    dirty_count = len([line for line in status_output.splitlines() if line.strip()])
    if dirty_count:
        findings.append(
            Finding(
                "HIGH",
                "DIRTY_TRACKED_WORKTREE",
                "Tracked files are modified; release provenance is not clean.",
                f"modified_tracked_entries={dirty_count}",
            )
        )

    _, tracked_output = run_command(["git", "ls-files", "-z"], root)
    tracked = [item for item in tracked_output.split("\0") if item]
    suspicious: list[str] = []
    for item in tracked:
        name = Path(item).name.lower()
        lower = item.lower()
        if name in {".env", "id.json"}:
            suspicious.append(item)
        elif "keypair" in name and name.endswith(".json"):
            suspicious.append(item)
        elif lower.endswith("/target/deploy"):
            suspicious.append(item)
    if suspicious:
        findings.append(
            Finding(
                "CRITICAL",
                "TRACKED_SECRET_LIKE_FILE",
                "Git tracks files whose names commonly contain signer secrets.",
                ", ".join(sorted(suspicious)[:20]),
            )
        )

    return {
        "is_repo": True,
        "commit": commit or None,
        "branch": branch or "<detached>",
        "dirty_tracked_entries": dirty_count,
    }


def inspect_versions(root: Path) -> dict[str, str | None]:
    commands = {
        "rustc": ["rustc", "--version"],
        "cargo": ["cargo", "--version"],
        "solana": ["solana", "--version"],
        "agave_install": ["agave-install", "--version"],
        "anchor": ["anchor", "--version"],
        "node": ["node", "--version"],
        "npm": ["npm", "--version"],
        "pnpm": ["pnpm", "--version"],
        "yarn": ["yarn", "--version"],
    }
    versions: dict[str, str | None] = {}
    for name, command in commands.items():
        if shutil.which(command[0]) is None:
            versions[name] = None
            continue
        code, output = run_command(command, root)
        versions[name] = last_line(output) if code == 0 else None
    return versions


def cluster_aliases(cluster: str) -> set[str]:
    normalized = cluster.lower().strip()
    aliases = {normalized}
    if normalized in {"mainnet", "mainnet-beta"}:
        aliases.update({"mainnet", "mainnet-beta"})
    if normalized in {"local", "localhost", "localnet"}:
        aliases.update({"local", "localhost", "localnet"})
    return aliases


def inspect_anchor(
    root: Path, cluster: str | None, findings: list[Finding]
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    path = root / "Anchor.toml"
    if not path.exists():
        return {"present": False}, []

    data = read_toml(path, findings)
    provider = data.get("provider") if isinstance(data.get("provider"), dict) else {}
    toolchain = data.get("toolchain") if isinstance(data.get("toolchain"), dict) else {}
    programs = data.get("programs") if isinstance(data.get("programs"), dict) else {}
    provider_cluster_raw = provider.get("cluster")
    provider_cluster = redacted_cluster(provider_cluster_raw)

    selected_names: list[str] = []
    if cluster:
        aliases = cluster_aliases(cluster)
        selected_names = [name for name in programs if name.lower() in aliases]
        if not selected_names:
            findings.append(
                Finding(
                    "HIGH",
                    "ANCHOR_CLUSTER_MISSING",
                    f"Anchor.toml has no programs section for requested cluster '{cluster}'.",
                    f"available={','.join(sorted(programs)) or '<none>'}",
                )
            )
        if isinstance(provider_cluster_raw, str) and "://" not in provider_cluster_raw:
            if provider_cluster_raw.lower() not in aliases:
                findings.append(
                    Finding(
                        "HIGH",
                        "ANCHOR_PROVIDER_CLUSTER_MISMATCH",
                        "Anchor provider cluster differs from the requested preflight cluster.",
                        f"provider={provider_cluster_raw}, requested={cluster}",
                    )
                )
    elif isinstance(provider_cluster_raw, str) and provider_cluster_raw in programs:
        selected_names = [provider_cluster_raw]
    else:
        selected_names = list(programs)

    identities: list[dict[str, str]] = []
    for cluster_name in selected_names:
        mapping = programs.get(cluster_name)
        if not isinstance(mapping, dict):
            continue
        for name, address in mapping.items():
            if valid_pubkey(address):
                identities.append(
                    {
                        "program": normalize_program_name(str(name)),
                        "address": str(address),
                        "source": f"Anchor.toml:[programs.{cluster_name}]",
                    }
                )
            else:
                findings.append(
                    Finding(
                        "HIGH",
                        "INVALID_ANCHOR_PROGRAM_ID",
                        f"Program '{name}' has an invalid address in Anchor.toml.",
                        f"cluster={cluster_name}",
                    )
                )

    anchor_version = toolchain.get("anchor_version") or toolchain.get("anchor-version")
    solana_version = toolchain.get("solana_version") or toolchain.get("solana-version")
    if not anchor_version:
        findings.append(
            Finding("MEDIUM", "ANCHOR_VERSION_UNPINNED", "Anchor.toml does not pin Anchor version.")
        )
    if not solana_version:
        findings.append(
            Finding(
                "MEDIUM",
                "SOLANA_VERSION_UNPINNED",
                "Anchor.toml does not pin the Solana/Agave toolchain version.",
            )
        )

    return (
        {
            "present": True,
            "provider_cluster": provider_cluster,
            "wallet_configured": bool(provider.get("wallet")),
            "toolchain": {
                "anchor_version": str(anchor_version) if anchor_version else None,
                "solana_version": str(solana_version) if solana_version else None,
            },
            "program_sections": sorted(programs),
            "selected_sections": sorted(selected_names),
        },
        identities,
    )


def inspect_source_ids(root: Path, findings: list[Finding]) -> list[dict[str, str]]:
    identities: list[dict[str, str]] = []
    candidates = sorted(root.glob("programs/**/src/lib.rs"))
    for path in candidates:
        try:
            if path.stat().st_size > 2_000_000:
                continue
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            findings.append(
                Finding(
                    "LOW",
                    "SOURCE_ID_READ_FAILED",
                    f"Could not inspect {safe_relative(path, root)} for declare_id!.",
                    type(exc).__name__,
                )
            )
            continue
        matches = DECLARE_ID_RE.findall(text)
        if len(set(matches)) > 1:
            findings.append(
                Finding(
                    "HIGH",
                    "MULTIPLE_DECLARE_IDS",
                    f"Multiple program IDs appear in {safe_relative(path, root)}.",
                    ", ".join(sorted(set(matches))),
                )
            )
        program_dir = path.parent.parent
        program = normalize_program_name(program_dir.name)
        for address in sorted(set(matches)):
            identities.append(
                {
                    "program": program,
                    "address": address,
                    "source": safe_relative(path, root),
                }
            )
    return identities


def inspect_idls(root: Path, findings: list[Finding]) -> list[dict[str, str]]:
    identities: list[dict[str, str]] = []
    for path in sorted((root / "target" / "idl").glob("*.json")):
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            findings.append(
                Finding(
                    "MEDIUM",
                    "IDL_PARSE_FAILED",
                    f"Could not parse {safe_relative(path, root)}.",
                    type(exc).__name__,
                )
            )
            continue
        metadata = document.get("metadata") if isinstance(document, dict) else {}
        if not isinstance(metadata, dict):
            metadata = {}
        address = document.get("address") if isinstance(document, dict) else None
        address = address or metadata.get("address")
        name = document.get("name") if isinstance(document, dict) else None
        name = name or metadata.get("name") or path.stem
        if valid_pubkey(address):
            identities.append(
                {
                    "program": normalize_program_name(str(name)),
                    "address": str(address),
                    "source": safe_relative(path, root),
                }
            )
    return identities


def inspect_keypairs(
    root: Path, findings: list[Finding], enabled: bool
) -> tuple[list[dict[str, str]], list[dict[str, Any]]]:
    if not enabled:
        return [], []
    identities: list[dict[str, str]] = []
    files: list[dict[str, Any]] = []
    keygen_available = shutil.which("solana-keygen") is not None
    for path in sorted((root / "target" / "deploy").glob("*-keypair.json")):
        try:
            mode = stat.S_IMODE(path.stat().st_mode)
        except OSError:
            mode = 0
        relative = safe_relative(path, root)
        public_key: str | None = None
        if mode & 0o077:
            findings.append(
                Finding(
                    "HIGH",
                    "KEYPAIR_PERMISSIONS_OPEN",
                    f"Keypair file permissions are broader than owner-only: {relative}.",
                    f"mode={oct(mode)}",
                )
            )
        if keygen_available:
            code, output = run_command(["solana-keygen", "pubkey", str(path)], root)
            if code == 0 and valid_pubkey(first_line(output)):
                public_key = first_line(output)
                program = normalize_program_name(path.name.removesuffix("-keypair.json"))
                identities.append(
                    {"program": program, "address": public_key, "source": relative}
                )
            else:
                findings.append(
                    Finding(
                        "HIGH",
                        "KEYPAIR_PUBKEY_FAILED",
                        f"Could not derive public key from {relative}.",
                    )
                )
        files.append(
            {"path": relative, "mode": oct(mode), "public_key": public_key or "<unresolved>"}
        )
    return identities, files


def inspect_pins(root: Path, findings: list[Finding]) -> dict[str, Any]:
    rust_pins = [name for name in ("rust-toolchain.toml", "rust-toolchain") if (root / name).exists()]
    if not rust_pins and (root / "Cargo.toml").exists():
        findings.append(
            Finding("MEDIUM", "RUST_TOOLCHAIN_UNPINNED", "Rust workspace has no rust-toolchain pin.")
        )
    if (root / "Cargo.toml").exists() and not (root / "Cargo.lock").exists():
        findings.append(
            Finding("MEDIUM", "CARGO_LOCK_MISSING", "Rust workspace has no Cargo.lock.")
        )

    lockfiles = [
        name
        for name in ("pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb")
        if (root / name).exists()
    ]
    if (root / "package.json").exists() and not lockfiles:
        findings.append(
            Finding("MEDIUM", "JS_LOCKFILE_MISSING", "JavaScript workspace has no recognized lockfile.")
        )

    packages: dict[str, str] = {}
    package_path = root / "package.json"
    if package_path.exists():
        try:
            package = json.loads(package_path.read_text(encoding="utf-8"))
            for section in ("dependencies", "devDependencies", "peerDependencies"):
                values = package.get(section, {}) if isinstance(package, dict) else {}
                if not isinstance(values, dict):
                    continue
                for name in (
                    "@anchor-lang/core",
                    "@coral-xyz/anchor",
                    "@solana/kit",
                    "@solana/web3.js",
                    "@solana/spl-token",
                ):
                    if name in values:
                        packages[name] = str(values[name])
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            findings.append(
                Finding(
                    "MEDIUM",
                    "PACKAGE_JSON_PARSE_FAILED",
                    "Could not parse package.json.",
                    type(exc).__name__,
                )
            )

    return {
        "rust_toolchain_files": rust_pins,
        "cargo_lock": (root / "Cargo.lock").exists(),
        "javascript_lockfiles": lockfiles,
        "solana_packages": dict(sorted(packages.items())),
    }


def correlate_identities(
    identities: Iterable[dict[str, str]], findings: list[Finding]
) -> dict[str, list[dict[str, str]]]:
    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    for identity in identities:
        grouped[normalize_program_name(identity["program"])].append(identity)

    result: dict[str, list[dict[str, str]]] = {}
    for program, records in sorted(grouped.items()):
        unique_addresses = sorted({record["address"] for record in records})
        if len(unique_addresses) > 1:
            evidence = "; ".join(
                f"{record['source']}={record['address']}" for record in records
            )
            findings.append(
                Finding(
                    "HIGH",
                    "PROGRAM_ID_MISMATCH",
                    f"Program identity sources disagree for '{program}'.",
                    evidence,
                )
            )
        result[program] = sorted(records, key=lambda item: (item["source"], item["address"]))
    return result


def render_text(report: dict[str, Any]) -> str:
    lines = [
        "Solana Release Preflight",
        f"root: {report['root']}",
        f"cluster: {report['cluster'] or '<not selected>'}",
        f"verdict: {report['verdict']}",
        "",
        "Git",
        json.dumps(report["git"], indent=2, sort_keys=True),
        "",
        "Tool versions",
    ]
    for name, version in report["tool_versions"].items():
        lines.append(f"- {name}: {version or '<not found>'}")
    lines.extend(["", "Pins", json.dumps(report["pins"], indent=2, sort_keys=True)])
    lines.extend(["", "Anchor", json.dumps(report["anchor"], indent=2, sort_keys=True)])
    lines.append("")
    lines.append("Program identities")
    if report["program_identities"]:
        for program, records in report["program_identities"].items():
            lines.append(f"- {program}")
            for record in records:
                lines.append(f"  - {record['address']} ({record['source']})")
    else:
        lines.append("- <none discovered>")
    lines.extend(["", "Deploy keypair inventory (public data only)"])
    if report["deploy_keypairs"]:
        for item in report["deploy_keypairs"]:
            lines.append(
                f"- {item['path']}: pubkey={item['public_key']}, mode={item['mode']}"
            )
    else:
        lines.append("- <none discovered or scan disabled>")
    lines.extend(["", "Findings"])
    if report["findings"]:
        for finding in report["findings"]:
            suffix = f" Evidence: {finding['evidence']}" if finding.get("evidence") else ""
            lines.append(
                f"- [{finding['severity']}] {finding['code']}: {finding['message']}{suffix}"
            )
    else:
        lines.append("- No static preflight findings. Live-chain and security checks remain required.")
    lines.extend(
        [
            "",
            "This report is read-only and does not verify on-chain state, artifact reproducibility, or protocol security.",
        ]
    )
    return "\n".join(lines)


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    root = Path(args.root).expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"Repository path is not a directory: {root}")

    findings: list[Finding] = []
    git = inspect_git(root, findings)
    versions = inspect_versions(root)
    pins = inspect_pins(root, findings)
    anchor, anchor_ids = inspect_anchor(root, args.cluster, findings)
    source_ids = inspect_source_ids(root, findings)
    idl_ids = inspect_idls(root, findings)
    keypair_ids, keypair_files = inspect_keypairs(root, findings, not args.no_keypair_scan)
    identities = correlate_identities(
        [*anchor_ids, *source_ids, *idl_ids, *keypair_ids], findings
    )

    if not args.cluster:
        findings.append(
            Finding(
                "MEDIUM",
                "TARGET_CLUSTER_UNSELECTED",
                "No target cluster was selected; cluster-specific identity cannot be proven.",
            )
        )
    findings.append(
        Finding(
            "INFO",
            "LIVE_STATE_NOT_CHECKED",
            "Run explicit RPC checks for program metadata, deployment slot, allocation, balance, and upgrade authority.",
        )
    )
    findings.append(
        Finding(
            "INFO",
            "ARTIFACT_NOT_BUILT",
            "This helper does not build, test, hash, deploy, sign, or verify artifacts.",
        )
    )

    findings.sort(key=lambda item: (SEVERITY_ORDER[item.severity], item.code, item.message))
    severities = {finding.severity for finding in findings}
    if "CRITICAL" in severities or "HIGH" in severities:
        verdict = "NO-GO"
    elif "MEDIUM" in severities:
        verdict = "GO WITH CONTROLS"
    else:
        verdict = "STATIC PREFLIGHT CLEAR"

    return {
        "schema_version": 1,
        "tool_version": VERSION,
        "root": str(root),
        "cluster": args.cluster,
        "verdict": verdict,
        "git": git,
        "tool_versions": versions,
        "pins": pins,
        "anchor": anchor,
        "program_identities": identities,
        "deploy_keypairs": keypair_files,
        "findings": [asdict(finding) for finding in findings],
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Inspect a Solana repository for release identity and provenance risks without mutation."
    )
    parser.add_argument("root", nargs="?", default=".", help="Repository root (default: current directory)")
    parser.add_argument(
        "--cluster",
        help="Target cluster name, e.g. devnet, testnet, mainnet, mainnet-beta, or localnet",
    )
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Return nonzero for Medium findings as well as High/Critical findings",
    )
    parser.add_argument(
        "--no-keypair-scan",
        action="store_true",
        help="Do not derive public keys from target/deploy/*-keypair.json",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    try:
        report = build_report(args)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(render_text(report))

    blocking = {"CRITICAL", "HIGH"}
    if args.strict:
        blocking.add("MEDIUM")
    return 1 if any(item["severity"] in blocking for item in report["findings"]) else 0


if __name__ == "__main__":
    raise SystemExit(main())
