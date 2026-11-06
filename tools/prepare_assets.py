"""Converts the raw 3D assets (downloaded models and textures) into web-ready files.

Usage:
    python -I tools/prepare_assets.py [SOURCE_DIR]

SOURCE_DIR defaults to ~/Downloads and must contain:
    Chips.obj, Textures.rar, All+the+Cards+Texture.zip, Poker_table.3DS

Outputs go to public/assets/. The script is idempotent.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_ROOT = PROJECT_ROOT / "public" / "assets"

# The source atlas is a 13x5 grid: rows = clubs, diamonds, hearts, spades, extras.
# Columns = A, 2..10, J, Q, K. The card back sits at row 4, column 2.
ATLAS_LEFT, ATLAS_RIGHT = 45, 4654
ATLAS_TOP, ATLAS_BOTTOM = 48, 2506
ATLAS_COLUMNS, ATLAS_ROWS = 13, 5
OUTLINE_INSET = 9  # skips the drawn black outline and its anti-aliasing
CARD_CELL_WIDTH, CARD_CELL_HEIGHT = 256, 360
CORNER_RADIUS_PX = 14
CARD_MARGIN_PX = 12
OUTLINE_CORNER_RADIUS_PX = 22

CHIP_DENOMINATION_TEXTURES = {
    1: "Light_Blue",
    5: "Red",
    25: "Dark_Green",
    100: "B_2",
    500: "Lavander",
    1000: "Orange",
    5000: "Dark_Cyan",
}
CHIP_TEXTURE_SIZE = 512
CHIP_OBJECTS_TO_KEEP = ("Low_Poly_Chip", "Mid_Poly_Chip")


def main() -> None:
    source_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Downloads"
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as work_dir_name:
        work_dir = Path(work_dir_name)
        prepare_card_atlas(source_dir / "All+the+Cards+Texture.zip", work_dir)
        prepare_chip_textures(source_dir / "Textures.rar", work_dir)
    prepare_chip_model(source_dir / "Chips.obj")
    prepare_table_model(source_dir / "Poker_table.3DS")
    print(f"Assets written to {OUTPUT_ROOT}")


def prepare_card_atlas(zip_path: Path, work_dir: Path) -> None:
    extract_dir = work_dir / "cards"
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(extract_dir)
    atlas_path = next(extract_dir.glob("*.png"))
    source = flatten_on_white(Image.open(atlas_path))

    column_width = (ATLAS_RIGHT - ATLAS_LEFT) / ATLAS_COLUMNS
    row_height = (ATLAS_BOTTOM - ATLAS_TOP) / ATLAS_ROWS
    output = Image.new(
        "RGB", (CARD_CELL_WIDTH * ATLAS_COLUMNS, CARD_CELL_HEIGHT * ATLAS_ROWS), "white"
    )

    for row in range(4):
        for column in range(ATLAS_COLUMNS):
            card = crop_cell(source, column, row, column_width, row_height)
            output.paste(card, (column * CARD_CELL_WIDTH, row * CARD_CELL_HEIGHT))

    back = crop_cell(source, 2, 4, column_width, row_height)
    output.paste(back, (0, 4 * CARD_CELL_HEIGHT))

    target = OUTPUT_ROOT / "cards"
    target.mkdir(parents=True, exist_ok=True)
    output.save(target / "cards_atlas.webp", "WEBP", quality=92, method=6)


def flatten_on_white(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    return Image.alpha_composite(background, rgba).convert("RGB")


def crop_cell(
    source: Image.Image, column: int, row: int, column_width: float, row_height: float
) -> Image.Image:
    left = round(ATLAS_LEFT + column * column_width) + OUTLINE_INSET
    right = round(ATLAS_LEFT + (column + 1) * column_width) - OUTLINE_INSET
    top = round(ATLAS_TOP + row * row_height) + OUTLINE_INSET
    bottom = round(ATLAS_TOP + (row + 1) * row_height) - OUTLINE_INSET
    inner_size = (
        CARD_CELL_WIDTH - 2 * CARD_MARGIN_PX,
        CARD_CELL_HEIGHT - 2 * CARD_MARGIN_PX,
    )
    content = source.crop((left, top, right, bottom)).resize(inner_size, Image.LANCZOS)
    # The outline is rounded, so its corner arcs survive the straight inset crop.
    content = whiten_outside_rounded_rect(content, OUTLINE_CORNER_RADIUS_PX)
    # The source indices touch the outline; a white margin mimics a printed card border.
    card = Image.new("RGB", (CARD_CELL_WIDTH, CARD_CELL_HEIGHT), "white")
    card.paste(content, (CARD_MARGIN_PX, CARD_MARGIN_PX))
    return whiten_outside_rounded_rect(card, CORNER_RADIUS_PX)


def whiten_outside_rounded_rect(card: Image.Image, radius: int) -> Image.Image:
    # The 3D card mesh has rounded corners; leftover outline arcs must not bleed into them.
    mask = Image.new("L", card.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, card.width - 1, card.height - 1), radius, fill=255
    )
    white = Image.new("RGB", card.size, "white")
    return Image.composite(card, white, mask)


def prepare_chip_textures(rar_path: Path, work_dir: Path) -> None:
    extract_dir = work_dir / "chips"
    extract_dir.mkdir()
    # Windows 10+ ships bsdtar (libarchive), which reads RAR archives.
    subprocess.run(["tar", "-xf", str(rar_path), "-C", str(extract_dir)], check=True)
    textures_dir = next(path for path in extract_dir.rglob("Textures") if path.is_dir())

    target = OUTPUT_ROOT / "chips"
    target.mkdir(parents=True, exist_ok=True)
    for denomination, color_name in CHIP_DENOMINATION_TEXTURES.items():
        texture = Image.open(
            textures_dir / f"Poker_Chip_Diffuse_{color_name}.png"
        ).convert("RGB")
        texture = texture.resize((CHIP_TEXTURE_SIZE, CHIP_TEXTURE_SIZE), Image.LANCZOS)
        texture.save(target / f"chip_{denomination}.webp", "WEBP", quality=90, method=6)

    normal_map = Image.open(textures_dir / "0.25m_Normal_Map.png").convert("RGB")
    normal_map.resize((1024, 1024), Image.LANCZOS).save(
        target / "chip_normal.png", optimize=True
    )


def prepare_chip_model(obj_path: Path) -> None:
    lines = obj_path.read_text(encoding="utf-8", errors="ignore").splitlines()
    positions: list[list[float]] = []
    uvs: list[str] = []
    normals: list[str] = []
    faces_by_object: dict[str, list[list[tuple[int, int, int]]]] = {}
    current_object = None

    for line in lines:
        if line.startswith("v "):
            positions.append([float(value) for value in line.split()[1:4]])
        elif line.startswith("vt "):
            uvs.append(line[3:].strip())
        elif line.startswith("vn "):
            normals.append(line[3:].strip())
        elif line.startswith("o "):
            current_object = line[2:].strip()
        elif line.startswith("f ") and current_object in CHIP_OBJECTS_TO_KEEP:
            face = []
            for token in line.split()[1:]:
                vertex, uv, normal = (int(part) - 1 for part in token.split("/"))
                face.append((vertex, uv, normal))
            faces_by_object.setdefault(current_object, []).append(face)

    output_lines = [
        "# Poker chip meshes extracted from Chips.obj, centered on the origin with base at y=0"
    ]
    vertex_offset = uv_offset = normal_offset = 0
    for object_name in CHIP_OBJECTS_TO_KEEP:
        faces = faces_by_object[object_name]
        vertex_ids = sorted({vertex for face in faces for vertex, _, _ in face})
        uv_ids = sorted({uv for face in faces for _, uv, _ in face})
        normal_ids = sorted({normal for face in faces for _, _, normal in face})
        center_x = (
            min(positions[i][0] for i in vertex_ids)
            + max(positions[i][0] for i in vertex_ids)
        ) / 2
        center_z = (
            min(positions[i][2] for i in vertex_ids)
            + max(positions[i][2] for i in vertex_ids)
        ) / 2
        base_y = min(positions[i][1] for i in vertex_ids)

        vertex_map = {
            old: index + vertex_offset + 1 for index, old in enumerate(vertex_ids)
        }
        uv_map = {old: index + uv_offset + 1 for index, old in enumerate(uv_ids)}
        normal_map = {
            old: index + normal_offset + 1 for index, old in enumerate(normal_ids)
        }

        output_lines.append(f"o {object_name}")
        for old in vertex_ids:
            x, y, z = positions[old]
            output_lines.append(
                f"v {x - center_x:.6f} {y - base_y:.6f} {z - center_z:.6f}"
            )
        output_lines.extend(f"vt {uvs[old]}" for old in uv_ids)
        output_lines.extend(f"vn {normals[old]}" for old in normal_ids)
        for face in faces:
            tokens = [
                f"{vertex_map[v]}/{uv_map[t]}/{normal_map[n]}" for v, t, n in face
            ]
            output_lines.append("f " + " ".join(tokens))

        vertex_offset += len(vertex_ids)
        uv_offset += len(uv_ids)
        normal_offset += len(normal_ids)

    target = OUTPUT_ROOT / "chips"
    target.mkdir(parents=True, exist_ok=True)
    (target / "chip.obj").write_text("\n".join(output_lines) + "\n", encoding="utf-8")


def prepare_table_model(model_path: Path) -> None:
    target = OUTPUT_ROOT / "table"
    target.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(model_path, target / "poker_table.3ds")


if __name__ == "__main__":
    main()
