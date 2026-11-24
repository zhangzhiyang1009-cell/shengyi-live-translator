#!/usr/bin/env python3
"""Download the official Argos OPUS models used for offline translation."""
import argparse
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import urllib.request

INDEX_URL = "https://raw.githubusercontent.com/argosopentech/argospm-index/main/index.json"
ROOT = Path(__file__).resolve().parents[1]
PAIRS = (("en", "zh"), ("zh", "en"))
VERSION = "1.9"


def get_json(url):
    request = urllib.request.Request(url, headers={"User-Agent": "shengyi-live-translator"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def select_packages():
    packages = get_json(INDEX_URL)
    selected = []
    for source, target in PAIRS:
        matches = [
            package for package in packages
            if package.get("from_code") == source
            and package.get("to_code") == target
            and package.get("package_version") == VERSION
            and package.get("links")
        ]
        if not matches:
            raise RuntimeError(f"Argos index does not contain {source}->{target} version {VERSION}")
        selected.append(matches[0])
    return selected


def install_package(package):
    source = package["from_code"]
    target = package["to_code"]
    name = f"translate-{source}_{target}-{VERSION.replace('.', '_')}"
    destination = ROOT / "models" / f"{source}_{target}" / name
    if (destination / "model" / "model.bin").exists() and (destination / "sentencepiece.model").exists():
        print(f"Already installed: {destination}")
        return

    url = package["links"][0]
    print(f"Downloading {source}->{target}: {url}")
    with tempfile.TemporaryDirectory(dir=ROOT) as temporary:
        archive_path = Path(temporary) / "model.argosmodel"
        request = urllib.request.Request(url, headers={"User-Agent": "shengyi-live-translator"})
        with urllib.request.urlopen(request, timeout=120) as response, archive_path.open("wb") as output:
            shutil.copyfileobj(response, output)

        destination.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive_path, "r:gz") as archive:
            for member in archive.getmembers():
                if not member.isfile():
                    continue
                path = Path(member.name)
                if not path.parts or path.parts[0] != name or ".." in path.parts:
                    continue
                relative = Path(*path.parts[1:])
                if not relative.parts:
                    continue
                if relative.parts[0] != "model" and len(relative.parts) == 1 and relative.name not in {
                    "sentencepiece.model", "metadata.json", "README.md",
                }:
                    continue
                if relative.parts[0] != "model" and len(relative.parts) > 1:
                    continue
                output_path = destination / relative
                output_path.parent.mkdir(parents=True, exist_ok=True)
                source_file = archive.extractfile(member)
                if source_file is None:
                    continue
                with source_file, output_path.open("wb") as output:
                    shutil.copyfileobj(source_file, output)
    print(f"Installed: {destination}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Only verify official model download links")
    args = parser.parse_args()
    packages = select_packages()
    for package in packages:
        if args.check:
            print(f"{package['from_code']}->{package['to_code']} {package['package_version']}: {package['links'][0]}")
        else:
            install_package(package)


if __name__ == "__main__":
    main()
