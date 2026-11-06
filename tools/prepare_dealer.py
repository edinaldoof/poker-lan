"""Builds public/assets/dealer/dealer.glb from the Renderpeople "Eric" rigged character archive.

Usage:
    python -I tools/prepare_dealer.py [ARCHIVE] [BLENDER_EXE]

ARCHIVE defaults to ~/Downloads/55-rp_eric_rigged_001_max.zip and BLENDER_EXE to the Blender 5.2 install path.
Steps: extract the Y-up A-pose FBX and its 8K textures, downscale them to web sizes (gloss is inverted into a
roughness map for PBR), then run Blender headless (tools/blender_export_dealer.py) to export a skinned GLB.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = None

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = PROJECT_ROOT / "public" / "assets" / "dealer" / "dealer.glb"
BLENDER_SCRIPT = PROJECT_ROOT / "tools" / "blender_export_dealer.py"
DEFAULT_ARCHIVE = Path.home() / "Downloads" / "55-rp_eric_rigged_001_max.zip"
DEFAULT_BLENDER = Path("C:/Program Files/Blender Foundation/Blender 5.2/blender.exe")

FBX_MEMBER = "rp_eric_rigged_001_yup_a.fbx"
TEXTURE_PREFIX = "tex/rp_eric_rigged_001_"
COLOR_SIZE = 2048
NORMAL_SIZE = 2048
ROUGHNESS_SIZE = 1024


def main() -> None:
    archive = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_ARCHIVE
    blender = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_BLENDER
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as work_dir_name:
        work_dir = Path(work_dir_name)
        fbx_path = extract_members(archive, work_dir)
        textures = prepare_textures(work_dir)
        run_blender_export(blender, fbx_path, textures, OUTPUT_PATH)

    size_mb = OUTPUT_PATH.stat().st_size / 1_000_000
    print(f"Dealer written to {OUTPUT_PATH} ({size_mb:.1f} MB)")


def extract_members(archive: Path, work_dir: Path) -> Path:
    wanted = {
        FBX_MEMBER,
        f"{TEXTURE_PREFIX}dif.jpg",
        f"{TEXTURE_PREFIX}norm.jpg",
        f"{TEXTURE_PREFIX}gloss.jpg",
    }
    with zipfile.ZipFile(archive) as bundle:
        for member in wanted:
            bundle.extract(member, work_dir)
    return work_dir / FBX_MEMBER


def prepare_textures(work_dir: Path) -> dict[str, Path]:
    source = work_dir / "tex"
    target = work_dir / "web"
    target.mkdir()

    color = Image.open(source / "rp_eric_rigged_001_dif.jpg").convert("RGB")
    color_path = target / "dealer_color.jpg"
    color.resize((COLOR_SIZE, COLOR_SIZE), Image.LANCZOS).save(
        color_path, quality=90, optimize=True
    )

    normal = Image.open(source / "rp_eric_rigged_001_norm.jpg").convert("RGB")
    normal_path = target / "dealer_normal.jpg"
    normal.resize((NORMAL_SIZE, NORMAL_SIZE), Image.LANCZOS).save(
        normal_path, quality=92, optimize=True
    )

    # glTF expects roughness (in the green channel); Renderpeople ships glossiness, its inverse.
    gloss = Image.open(source / "rp_eric_rigged_001_gloss.jpg").convert("L")
    roughness = ImageOps.invert(
        gloss.resize((ROUGHNESS_SIZE, ROUGHNESS_SIZE), Image.LANCZOS)
    )
    roughness_path = target / "dealer_roughness.jpg"
    Image.merge("RGB", (roughness, roughness, roughness)).save(
        roughness_path, quality=90, optimize=True
    )

    return {"color": color_path, "normal": normal_path, "roughness": roughness_path}


def run_blender_export(
    blender: Path, fbx_path: Path, textures: dict[str, Path], output: Path
) -> None:
    command = [
        str(blender),
        "--background",
        "--factory-startup",
        "--python",
        str(BLENDER_SCRIPT),
        "--",
        str(fbx_path),
        str(textures["color"]),
        str(textures["normal"]),
        str(textures["roughness"]),
        str(output),
    ]
    subprocess.run(command, check=True)


if __name__ == "__main__":
    main()
