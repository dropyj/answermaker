#!/usr/bin/env python3
"""Generate AnswerMaker multi-size icons from the source artwork.

Source: the glossy gradient "A" artwork chosen by the user
(imagine_media/media-generation-answermaker-icon-a-0-...webp).
The flat variant is intentionally NOT used.

Usage: python3 scripts/make-icons.py [source_image]
Outputs:
  src-tauri/icons/icon.png (512), 32x32.png, 128x128.png, 256x256.png, 512x512.png
  src-tauri/icons/icon.ico (Windows, if Pillow ICO save succeeds)
  src-tauri/icons/icon.icns is NOT generated here (needs macOS iconutil);
  public/logo.png (512) and public/favicon.png (64)
"""
import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SRC = Path.home() / "workspace/imagine_media/media-generation-answermaker-icon-a-0-addb4b1a-ecce-4142-9da8-e9bf371ea092.webp"

def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    img = Image.open(src).convert("RGBA")
    icons_dir = ROOT / "src-tauri" / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)
    public_dir = ROOT / "public"
    public_dir.mkdir(parents=True, exist_ok=True)
    for size in (32, 128, 256, 512):
        out = img.resize((size, size), Image.LANCZOS)
        out.save(icons_dir / f"{size}x{size}.png")
        print(f"wrote {icons_dir / f'{size}x{size}.png'}")
    img.resize((512, 512), Image.LANCZOS).save(icons_dir / "icon.png")
    img.resize((512, 512), Image.LANCZOS).save(public_dir / "logo.png")
    img.resize((64, 64), Image.LANCZOS).save(public_dir / "favicon.png")
    print("wrote icon.png, public/logo.png, public/favicon.png")
    try:
        img.save(icons_dir / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
        print("wrote icon.ico")
    except Exception as e:  # noqa: BLE001
        print(f"icon.ico generation skipped: {e}")

if __name__ == "__main__":
    main()
