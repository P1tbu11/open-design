#!/usr/bin/env python3
"""Deterministic spatial-anchor & zero-stretch compositor for game showcase UIs.

Subcommands:
  anchor   Measure exact character foot coordinates from alpha channel and
           render a canvas-matched spatial layout guide PNG (`guide.png`).
  compose  Cover-fit a generated background plate to the UI canvas without
           edge-smear padding, apply left-zone DOF + frosted empty-slot glass +
           grounded character shadows/bounce lighting, and composite UI layers.
"""

from __future__ import annotations

import argparse
import json
import os
from typing import Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def measure_alpha_bbox(alpha: np.ndarray, threshold: int = 16) -> list[int]:
    ys, xs = np.where(alpha > threshold)
    if len(xs) == 0 or len(ys) == 0:
        h, w = alpha.shape
        return [int(w * 0.60), int(h * 0.30), int(w * 0.82), int(h * 0.84)]
    return [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]


def parse_box(spec: str) -> list[int]:
    parts = [int(x.strip()) for x in spec.split(",")]
    if len(parts) != 4:
        raise ValueError(f"Expected x0,y0,x1,y1 box, got: {spec}")
    return parts


def render_spatial_guide(
    width: int,
    height: int,
    cx_norm: float,
    feet_y_norm: float,
    ui_left_ratio: float,
    theme: str,
    arch: str,
) -> Image.Image:
    is_dark = theme == "dark"
    bg_rgb = (22, 18, 38) if is_dark else (228, 220, 242)
    left_rgb = (15, 13, 27) if is_dark else (216, 208, 232)
    frame_fill = (52, 40, 86, 235) if is_dark else (246, 240, 255, 235)
    frame_outline = (146, 122, 212, 255) if is_dark else (218, 188, 128, 255)
    glow_rgba = (176, 152, 248, 96) if is_dark else (255, 248, 255, 135)
    top_disc = (126, 108, 182, 255) if is_dark else (242, 232, 252, 255)
    side_disc = (68, 54, 108, 255) if is_dark else (206, 184, 224, 255)

    base = Image.new("RGBA", (width, height), (*bg_rgb, 255))
    draw = ImageDraw.Draw(base, "RGBA")

    # Calm left UI region so generated scenery stays uncluttered behind cards.
    ui_x = int(width * ui_left_ratio)
    draw.rectangle([0, 0, ui_x, height], fill=(*left_rgb, 255))

    cx = int(width * cx_norm)
    fy = int(height * feet_y_norm)
    arch_w = int(width * 0.21)
    arch_top = int(height * 0.16)
    arch_bot = fy + int(height * 0.02)

    if arch == "gothic":
        pts = [
            (cx - arch_w // 2, arch_bot),
            (cx - arch_w // 2, int(height * 0.40)),
            (cx - int(arch_w * 0.34), int(height * 0.24)),
            (cx, arch_top),
            (cx + int(arch_w * 0.34), int(height * 0.24)),
            (cx + arch_w // 2, int(height * 0.40)),
            (cx + arch_w // 2, arch_bot),
        ]
        draw.polygon(pts, fill=frame_fill, outline=frame_outline)
    elif arch == "round":
        draw.rounded_rectangle(
            [cx - arch_w // 2, arch_top, cx + arch_w // 2, arch_bot],
            radius=arch_w // 2,
            fill=frame_fill,
            outline=frame_outline,
            width=max(2, width // 700),
        )
    else:
        box_w = int(width * 0.28)
        draw.rounded_rectangle(
            [cx - box_w // 2, int(height * 0.18), cx + box_w // 2, arch_bot],
            radius=max(12, width // 140),
            fill=frame_fill,
            outline=frame_outline,
            width=max(2, width // 700),
        )

    # Soft spotlight layer (deliberately empty — no character silhouette).
    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow, "RGBA")
    gd.ellipse(
        [
            cx - int(arch_w * 0.42),
            int(height * 0.24),
            cx + int(arch_w * 0.42),
            fy + int(height * 0.03),
        ],
        fill=glow_rgba,
    )
    glow = glow.filter(ImageFilter.GaussianBlur(radius=max(16, width // 95)))
    base = Image.alpha_composite(base, glow)

    # Flat unoccupied pedestal anchored strictly at (cx, feet_y).
    d2 = ImageDraw.Draw(base, "RGBA")
    rx = int(width * 0.095)
    ry = int(height * 0.030)
    plinth_h = int(height * 0.052)
    d2.rectangle([cx - rx, fy, cx + rx, fy + plinth_h], fill=side_disc)
    d2.ellipse([cx - rx, fy + plinth_h - ry, cx + rx, fy + plinth_h + ry], fill=side_disc)
    d2.ellipse(
        [cx - rx, fy - ry, cx + rx, fy + ry],
        fill=top_disc,
        outline=frame_outline,
        width=max(2, width // 900),
    )

    # Downsample to 1920-wide guide for fast upload while preserving exact aspect ratio.
    guide_w = min(width, 1920)
    guide_h = round(height * (guide_w / width))
    return base.convert("RGB").resize((guide_w, guide_h), Image.Resampling.LANCZOS)


def cmd_anchor(args: argparse.Namespace) -> None:
    char_im = Image.open(args.character).convert("RGBA")
    ui_im = Image.open(args.ui).convert("RGBA")
    width, height = ui_im.size
    if char_im.size != (width, height):
        char_im = char_im.resize((width, height), Image.Resampling.LANCZOS)

    alpha = np.asarray(char_im)[..., 3]
    bbox = measure_alpha_bbox(alpha)
    cx_px = round((bbox[0] + bbox[2]) * 0.5)
    feet_y_px = bbox[3]
    cx_norm = round(cx_px / width, 5)
    feet_y_norm = round(feet_y_px / height, 5)

    empty_slots: list[list[int]] = [parse_box(s) for s in (args.empty_slot or [])]

    guide = render_spatial_guide(
        width=width,
        height=height,
        cx_norm=cx_norm,
        feet_y_norm=feet_y_norm,
        ui_left_ratio=args.ui_left_ratio,
        theme=args.theme,
        arch=args.arch,
    )
    os.makedirs(os.path.dirname(os.path.abspath(args.out_guide)), exist_ok=True)
    guide.save(args.out_guide, optimize=True)

    meta = {
        "canvas_size": [width, height],
        "character_bbox": bbox,
        "anchor_px": [cx_px, feet_y_px],
        "anchor_norm": [cx_norm, feet_y_norm],
        "ui_left_ratio": args.ui_left_ratio,
        "theme": args.theme,
        "arch": args.arch,
        "empty_slots": empty_slots,
        "guide_path": args.out_guide,
    }
    if args.out_meta:
        os.makedirs(os.path.dirname(os.path.abspath(args.out_meta)), exist_ok=True)
        with open(args.out_meta, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

    print(json.dumps(meta, ensure_ascii=False))


def cover_fit_to_anchor(
    plate: Image.Image,
    target_w: int,
    target_h: int,
    target_anchor_norm: Sequence[float],
    plate_anchor_norm: Sequence[float] | None = None,
) -> tuple[Image.Image, float]:
    """Scale & crop `plate` to `(target_w, target_h)` with ZERO edge-smear padding."""
    pw, ph = plate.size
    tx = target_w * float(target_anchor_norm[0])
    ty = target_h * float(target_anchor_norm[1])
    ax = float(plate_anchor_norm[0]) if plate_anchor_norm else float(target_anchor_norm[0])
    ay = float(plate_anchor_norm[1]) if plate_anchor_norm else float(target_anchor_norm[1])

    # Minimum scale that BOTH covers the canvas AND lets (ax, ay) land on (tx, ty)
    # without stepping outside image bounds (zero edge-stretch guarantee).
    min_scale_w = max(tx / max(ax * pw, 1.0), (target_w - tx) / max((1.0 - ax) * pw, 1.0))
    min_scale_h = max(ty / max(ay * ph, 1.0), (target_h - ty) / max((1.0 - ay) * ph, 1.0))
    scale = max(target_w / pw, target_h / ph, min_scale_w, min_scale_h)

    # Cap extreme zoom if a manual plate_anchor_norm was way off; clamp crop cleanly.
    max_scale = max(target_w / pw, target_h / ph) * 1.22
    scale = min(scale, max_scale)

    nw = max(target_w, int(round(pw * scale)))
    nh = max(target_h, int(round(ph * scale)))
    resized = plate.convert("RGB").resize((nw, nh), Image.Resampling.LANCZOS)

    x0 = int(round(ax * nw - tx))
    y0 = int(round(ay * nh - ty))
    x0 = max(0, min(nw - target_w, x0))
    y0 = max(0, min(nh - target_h, y0))

    cropped = resized.crop((x0, y0, x0 + target_w, y0 + target_h))
    zoom_vs_cover = round(scale / max(target_w / pw, target_h / ph), 4)
    return cropped, zoom_vs_cover


def apply_left_ui_dof_and_scrim(
    bg_rgb: Image.Image, ui_left_ratio: float, theme: str
) -> Image.Image:
    w, h = bg_rgb.size
    blurred = bg_rgb.filter(ImageFilter.GaussianBlur(radius=max(6, w // 380)))

    # Smooth horizontal mask fading out around ui_left_ratio.
    xs = np.linspace(0.0, 1.0, w, dtype=np.float32)
    fade = np.clip((ui_left_ratio + 0.05 - xs) / 0.12, 0.0, 1.0)
    mask_arr = (fade[None, :] * 185.0).astype(np.uint8)
    mask = Image.fromarray(np.repeat(mask_arr, h, axis=0), mode="L")
    out = Image.composite(blurred, bg_rgb, mask)

    # Subtle contrast scrim behind left cards.
    scrim = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    scrim_color = (10, 10, 20) if theme == "dark" else (28, 22, 42)
    max_alpha = 56 if theme == "dark" else 26
    scrim_alpha = np.repeat((fade[None, :] * max_alpha).astype(np.uint8), h, axis=0)
    scrim_rgba = np.zeros((h, w, 4), dtype=np.uint8)
    scrim_rgba[..., 0] = scrim_color[0]
    scrim_rgba[..., 1] = scrim_color[1]
    scrim_rgba[..., 2] = scrim_color[2]
    scrim_rgba[..., 3] = scrim_alpha
    scrim = Image.fromarray(scrim_rgba, mode="RGBA")
    return Image.alpha_composite(out.convert("RGBA"), scrim)


def apply_frosted_empty_slots(
    canvas_rgba: Image.Image, slots: Sequence[Sequence[int]], theme: str
) -> Image.Image:
    if not slots:
        return canvas_rgba
    out = canvas_rgba.copy()
    w, _ = out.size
    radius = max(12, w // 230)
    for box in slots:
        x0, y0, x1, y1 = [int(v) for v in box]
        crop = out.crop((x0, y0, x1, y1)).filter(
            ImageFilter.GaussianBlur(radius=max(8, w // 260))
        )
        patch = Image.new("RGBA", (x1 - x0, y1 - y0), (0, 0, 0, 0))
        mask = Image.new("L", (x1 - x0, y1 - y0), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, x1 - x0 - 1, y1 - y0 - 1], radius=radius, fill=255
        )
        patch.paste(crop, (0, 0), mask)

        tint = Image.new("RGBA", (x1 - x0, y1 - y0), (0, 0, 0, 0))
        td = ImageDraw.Draw(tint, "RGBA")
        fill_rgba = (255, 255, 255, 26) if theme == "dark" else (255, 255, 255, 58)
        border_rgba = (255, 255, 255, 54) if theme == "dark" else (255, 255, 255, 110)
        td.rounded_rectangle(
            [0, 0, x1 - x0 - 1, y1 - y0 - 1],
            radius=radius,
            fill=fill_rgba,
            outline=border_rgba,
            width=max(2, w // 1400),
        )
        patch = Image.alpha_composite(patch, tint)
        out.paste(patch, (x0, y0), mask)
    return out


def composite_character_with_lighting(
    canvas_rgba: Image.Image,
    char_rgba: Image.Image,
    anchor_px: Sequence[int],
    char_bbox: Sequence[int],
    theme: str,
) -> Image.Image:
    w, h = canvas_rgba.size
    cx, fy = int(anchor_px[0]), int(anchor_px[1])
    bx0, by0, bx1, by1 = [int(v) for v in char_bbox]
    char_w = max(1, bx1 - bx0)

    # 1. Soft backlight halo behind character silhouette so fur/edges separate cleanly.
    char_alpha = char_rgba.split()[3]
    halo_mask = char_alpha.filter(ImageFilter.GaussianBlur(radius=max(18, w // 130)))
    halo_rgb = (188, 166, 255) if theme == "dark" else (255, 246, 232)
    halo_strength = 0.26 if theme == "dark" else 0.18
    halo_arr = np.zeros((h, w, 4), dtype=np.uint8)
    halo_arr[..., 0] = halo_rgb[0]
    halo_arr[..., 1] = halo_rgb[1]
    halo_arr[..., 2] = halo_rgb[2]
    halo_arr[..., 3] = np.clip(np.asarray(halo_mask, dtype=np.float32) * halo_strength, 0, 255).astype(np.uint8)
    out = Image.alpha_composite(canvas_rgba, Image.fromarray(halo_arr, mode="RGBA"))

    # 2. Dual-layer grounded AO + tight contact shadow under feet.
    shadow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow, "RGBA")
    ao_rx = int(char_w * 0.46)
    ao_ry = max(10, int(h * 0.022))
    sd.ellipse([cx - ao_rx, fy - ao_ry, cx + ao_rx, fy + ao_ry], fill=(10, 6, 22, 115 if theme == "dark" else 78))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=max(12, w // 190)))

    tight = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    td = ImageDraw.Draw(tight, "RGBA")
    t_rx = int(char_w * 0.28)
    t_ry = max(6, int(h * 0.010))
    td.ellipse([cx - t_rx, fy - t_ry, cx + t_rx, fy + t_ry], fill=(8, 5, 18, 155 if theme == "dark" else 110))
    tight = tight.filter(ImageFilter.GaussianBlur(radius=max(5, w // 480)))

    out = Image.alpha_composite(out, shadow)
    out = Image.alpha_composite(out, tight)

    # 3. Sample pedestal color right below feet and apply gentle lower-body bounce light.
    sample_y0 = max(0, fy - int(h * 0.01))
    sample_y1 = min(h, fy + int(h * 0.03))
    sample_x0 = max(0, cx - int(char_w * 0.25))
    sample_x1 = min(w, cx + int(char_w * 0.25))
    bg_patch = np.asarray(out)[sample_y0:sample_y1, sample_x0:sample_x1, :3]
    bounce_rgb = bg_patch.mean(axis=(0, 1)) if bg_patch.size else np.array([180.0, 160.0, 220.0])

    char_arr = np.asarray(char_rgba, dtype=np.float32).copy()
    ys = np.arange(h, dtype=np.float32)[:, None]
    bounce_band = np.clip((ys - (by1 - (by1 - by0) * 0.30)) / max(1.0, (by1 - by0) * 0.30), 0.0, 1.0)
    blend = bounce_band[..., None] * (0.14 if theme == "dark" else 0.10)
    char_arr[..., :3] = char_arr[..., :3] * (1.0 - blend) + bounce_rgb[None, None, :] * blend
    lit_char = Image.fromarray(np.clip(char_arr, 0, 255).astype(np.uint8), mode="RGBA")

    return Image.alpha_composite(out, lit_char)


def cmd_compose(args: argparse.Namespace) -> None:
    with open(args.anchor, "r", encoding="utf-8") as f:
        meta = json.load(f)

    ui_im = Image.open(args.ui).convert("RGBA")
    char_im = Image.open(args.character).convert("RGBA")
    plate_im = Image.open(args.plate).convert("RGB")

    width, height = ui_im.size
    if char_im.size != (width, height):
        char_im = char_im.resize((width, height), Image.Resampling.LANCZOS)

    plate_anchor = (
        [float(x) for x in args.plate_anchor.split(",")]
        if args.plate_anchor
        else None
    )
    theme = args.theme or meta.get("theme", "dark")
    ui_left_ratio = float(meta.get("ui_left_ratio", 0.46))

    fitted_rgb, zoom_vs_cover = cover_fit_to_anchor(
        plate=plate_im,
        target_w=width,
        target_h=height,
        target_anchor_norm=meta["anchor_norm"],
        plate_anchor_norm=plate_anchor,
    )

    staged_rgba = apply_left_ui_dof_and_scrim(fitted_rgb, ui_left_ratio, theme)

    slots = list(meta.get("empty_slots") or [])
    if args.empty_slot:
        slots.extend(parse_box(s) for s in args.empty_slot)
    staged_rgba = apply_frosted_empty_slots(staged_rgba, slots, theme)

    staged_rgba = composite_character_with_lighting(
        canvas_rgba=staged_rgba,
        char_rgba=char_im,
        anchor_px=meta["anchor_px"],
        char_bbox=meta["character_bbox"],
        theme=theme,
    )

    final_rgba = Image.alpha_composite(staged_rgba, ui_im)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    final_rgba.convert("RGB").save(args.out, quality=95)
    print(
        json.dumps(
            {
                "output": args.out,
                "size": [width, height],
                "zoom_vs_cover": zoom_vs_cover,
                "edge_stretch_px": [0, 0, 0, 0],
            },
            ensure_ascii=False,
        )
    )


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    pa = sub.add_parser("anchor", help="Measure character feet & render spatial guide PNG")
    pa.add_argument("--character", required=True, help="Path to transparent character-layer.png")
    pa.add_argument("--ui", required=True, help="Path to transparent ui-layer.png")
    pa.add_argument("--out-guide", required=True, help="Output guide PNG path")
    pa.add_argument("--out-meta", default="", help="Output anchor metadata JSON path")
    pa.add_argument("--theme", choices=["dark", "light"], default="dark")
    pa.add_argument("--arch", choices=["gothic", "round", "frame"], default="round")
    pa.add_argument("--ui-left-ratio", type=float, default=0.46)
    pa.add_argument("--empty-slot", action="append", help="Optional x0,y0,x1,y1 empty card slot(s)")
    pa.set_defaults(func=cmd_anchor)

    pc = sub.add_parser("compose", help="Zero-stretch cover fit + optical UI/character composite")
    pc.add_argument("--plate", required=True, help="Generated background plate PNG/JPG")
    pc.add_argument("--anchor", required=True, help="Path to anchor_meta.json from `anchor`")
    pc.add_argument("--character", required=True, help="Path to character-layer.png")
    pc.add_argument("--ui", required=True, help="Path to ui-layer.png")
    pc.add_argument("--out", required=True, help="Final composited PNG path")
    pc.add_argument("--theme", choices=["dark", "light"], default="")
    pc.add_argument("--plate-anchor", default="", help="Optional override ax,ay if plate shifted")
    pc.add_argument("--empty-slot", action="append", help="Optional x0,y0,x1,y1 empty card slot(s)")
    pc.set_defaults(func=cmd_compose)
    return p


if __name__ == "__main__":
    parser = build_parser()
    ns = parser.parse_args()
    ns.func(ns)
