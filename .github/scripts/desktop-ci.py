"""Prepare native desktop resources and collect CI installers (stdlib only)."""

import hashlib
import ipaddress
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
DESKTOP = ROOT / "apps/desktop"
TAURI = DESKTOP / "src-tauri"
JDBC = ROOT / "services/jdbc/target"


def api_origin():
    origin = os.environ.get("API_ORIGIN", "").strip()
    parsed = urlsplit(origin)
    # Allow a deployment path prefix, but never credentials, query or fragment.
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment
            or any(c.isspace() or c in ";'\"<>\\" for c in origin)
            or origin != f"{parsed.scheme}://{parsed.netloc}{parsed.path}"):
        raise ValueError("API base URL must be http(s)://host[:port][/prefix/] without credentials, query or fragment")
    parsed.port  # Also reject malformed ports.
    if parsed.scheme == "http":
        try:
            address = ipaddress.ip_address(parsed.hostname)
        except ValueError:
            address = None
        private_networks = ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
        if not (parsed.hostname == "localhost" or (address is not None and (
                address.is_loopback or any(address in ipaddress.ip_network(net) for net in private_networks)))):
            raise ValueError("HTTP API origin must use localhost, a loopback IP or an RFC1918 private IP")
    return origin


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def prepare():
    base_url = api_origin()
    parsed = urlsplit(base_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    jar = JDBC / "tabledb-jdbc.jar"
    drivers = JDBC / "drivers"
    manifest = json.loads((drivers / "manifest.json").read_text(encoding="utf-8"))
    if not jar.is_file() or not manifest["drivers"]:
        raise ValueError("JDBC jar or driver entries missing")
    for driver in manifest["drivers"]:
        path = drivers / driver["file"]
        if path.parent != drivers or sha256(path) != driver["sha256"]:
            raise ValueError(f"Invalid driver or checksum: {driver['file']}")

    resources = TAURI / "resources"
    sidecar = resources / "sidecar"
    shutil.rmtree(sidecar, ignore_errors=True)
    sidecar.mkdir(parents=True)
    shutil.copy2(jar, sidecar / jar.name)
    shutil.copytree(drivers, sidecar / "drivers")

    jre = resources / "jre"
    shutil.rmtree(jre, ignore_errors=True)
    exe = ".exe" if sys.platform == "win32" else ""
    java_bin = Path(os.environ["JAVA_HOME"]) / "bin"
    modules = (
        "java.base,java.logging,java.sql,java.naming,java.net.http,java.management,"
        "java.security.jgss,java.security.sasl,java.xml,jdk.unsupported,"
        "jdk.httpserver,jdk.crypto.ec,jdk.naming.dns"
    )
    subprocess.run([
        str(java_bin / f"jlink{exe}"), "--add-modules", modules,
        "--strip-debug", "--no-header-files", "--no-man-pages",
        "--compress", "zip-6", "--output", str(jre),
    ], check=True)
    subprocess.run([str(jre / "bin" / f"java{exe}"), "-version"], check=True)
    subprocess.run([
        str(jre / "bin" / f"java{exe}"), "-jar", str(sidecar / jar.name), "--stdio",
    ], input=b"", cwd=sidecar, check=True, timeout=30)

    config = json.loads((TAURI / "tauri.conf.json").read_text(encoding="utf-8"))
    directives = config["app"]["security"]["csp"].split(";")
    for index, directive in enumerate(directives):
        if directive.strip().startswith("connect-src "):
            directives[index] = f" connect-src 'self' ipc: http://ipc.localhost {origin}"
            break
    else:
        raise ValueError("Base CSP has no connect-src directive")
    override = {
        "app": {"security": {"csp": ";".join(directives)}},
        "bundle": {"createUpdaterArtifacts": False},
    }
    if sys.platform == "win32":
        override["bundle"]["windows"] = {
            "webviewInstallMode": {"type": "offlineInstaller"},
        }
    (DESKTOP / "tauri.ci.json").write_text(json.dumps(override), encoding="utf-8")
    deployment_path = TAURI / "deployment.json"
    deployment = json.loads(deployment_path.read_text(encoding="utf-8"))
    deployment["apiBaseUrl"] = base_url
    if os.environ.get("TABLEDB_SERVER_SIGNING_PUBLIC_KEY"):
        deployment["serverSigningPublicKey"] = os.environ["TABLEDB_SERVER_SIGNING_PUBLIC_KEY"]
    deployment_path.write_text(json.dumps(deployment, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def verify_appimage():
    bundle = TAURI / "target" / os.environ["BUILD_TARGET"] / "release/bundle/appimage"
    images = list(bundle.glob("*.AppImage"))
    if len(images) != 1:
        raise ValueError(f"Expected one AppImage in {bundle}, found {len(images)}")
    config = json.loads((TAURI / "tauri.conf.json").read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(prefix="tabledb-appimage-") as directory:
        subprocess.run([str(images[0]), "--appimage-extract"], cwd=directory,
                       stdout=subprocess.DEVNULL, check=True, timeout=120)
        resources = Path(directory) / "squashfs-root/usr/lib" / config["productName"] / "resources"
        java = resources / "jre/bin/java"
        sidecar = resources / "sidecar"
        # Check the relocated JRE without the linker paths used during packaging.
        env = dict(os.environ)
        env.pop("LD_LIBRARY_PATH", None)
        subprocess.run([str(java), "-version"], env=env, check=True, timeout=30)
        subprocess.run([str(java), "-jar", str(sidecar / "tabledb-jdbc.jar"), "--stdio"],
                       input=b"", cwd=sidecar, env=env, check=True, timeout=30)


def collect():
    bundle = TAURI / "target" / os.environ["BUILD_TARGET"] / "release/bundle"
    output = ROOT / "desktop-artifacts"
    shutil.rmtree(output, ignore_errors=True)
    output.mkdir()
    files = [path for path in bundle.rglob("*") if path.is_file()
             and path.suffix in {".exe", ".dmg", ".deb", ".AppImage", ".rpm"}
             and not any(part.endswith(".app") for part in path.relative_to(bundle).parts)]
    if not files:
        raise ValueError(f"No installers found in {bundle}")
    for path in sorted(files):
        destination = output / path.name
        if destination.exists():
            raise ValueError(f"Duplicate installer filename: {path.name}")
        shutil.copy2(path, destination)
    sums = [f"{sha256(path)}  {path.name}" for path in sorted(output.iterdir())]
    (output / "SHA256SUMS.txt").write_text("\n".join(sums) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    commands = {"validate": api_origin, "prepare": prepare, "verify-appimage": verify_appimage, "collect": collect}
    commands[sys.argv[1]]()
