# -*- coding: utf-8 -*-
"""
TransForge Logo 生成与 iOS 图标应用脚本

通过 OpenAI 兼容的 API 中转站调用生图模型生成 Logo 候选图，并将选定图片写入 iOS AppIcon。
密钥只从环境变量读取，脚本不会打印或落盘任何密钥。

环境变量：
    RELAY_BASE_URL     中转站地址，默认 https://www.mirtop.online/v1
    RELAY_API_KEY      中转站 Key
    RELAY_IMAGE_MODEL  生图模型名，默认 gemini-2.5-flash-image

用法：
    python gen_logo.py generate [--n 3]          生成候选图到 docs/logo/
    python gen_logo.py apply <候选图路径>        应用为 iOS AppIcon（1024x1024，去除透明通道）
"""
import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request
from io import BytesIO
from pathlib import Path

from PIL import Image

# 项目根目录与输出目录
ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "docs" / "logo"
# iOS 工程唯一的 AppIcon 文件（Contents.json 已指向此文件名）
IOS_ICON = ROOT / "web" / "ios" / "App" / "App" / "Assets.xcassets" / "AppIcon.appiconset" / "AppIcon-512@2x.png"
# App 主题深色底，用于去除透明通道时的填充色
BG_COLOR = (9, 9, 11)

# Logo 设计提示词：深色底 + 翡翠绿高光，屏幕框 + 文字原位替换意象
PROMPT = (
    "A premium iOS app icon for 'TransForge', a real-time on-screen translation app. "
    "Square full-bleed composition, solid near-black background (#09090b), no rounded corners, no border, no padding frame. "
    "Centered symbol: a minimal rounded smartphone/screen outline in soft white, inside it two short horizontal text bars; "
    "the upper bar is a dim gray Latin letter 'A', the lower bar is glowing emerald green (#10b981) Chinese character '文', "
    "with a subtle diagonal swap arrow suggesting in-place text replacement. "
    "Flat modern vector style, crisp geometric shapes, gentle emerald glow, high contrast, clean negative space, "
    "readable at small sizes. No other text, no watermark, no mockup, no shadow outside the icon."
)


class RelayError(Exception):
    """中转站请求异常"""


def _env(name: str, default: str = "") -> str:
    """读取环境变量，必填项缺失时直接退出"""
    value = os.environ.get(name, default).strip()
    if not value:
        sys.exit(f"缺少环境变量 {name}，请先设置后再运行")
    return value


def _post_json(url: str, key: str, payload: dict, timeout: int = 180) -> dict:
    """向中转站发送 JSON POST 请求并返回解析后的 JSON"""
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        with e:
            body = e.read().decode("utf-8", errors="replace")[:500]
        raise RelayError(f"HTTP {e.code}: {body}") from e
    except urllib.error.URLError as e:
        raise RelayError(f"网络错误: {e.reason}") from e


def _download(url: str) -> bytes:
    """下载图片 URL"""
    with urllib.request.urlopen(url, timeout=120) as resp:
        return resp.read()


def _via_images_api(base: str, key: str, model: str) -> bytes:
    """方式一：标准 /images/generations 接口"""
    data = _post_json(f"{base}/images/generations", key, {
        "model": model, "prompt": PROMPT, "n": 1, "size": "1024x1024",
    })
    item = (data.get("data") or [{}])[0]
    if item.get("b64_json"):
        return base64.b64decode(item["b64_json"])
    if item.get("url"):
        return _download(item["url"])
    raise RelayError(f"images 接口未返回图片: {str(data)[:300]}")


def _via_chat_api(base: str, key: str, model: str) -> bytes:
    """方式二：/chat/completions 接口（部分中转站的 Gemini 生图走这里，图片以 base64 或 URL 形式嵌在回复中）"""
    data = _post_json(f"{base}/chat/completions", key, {
        "model": model,
        "messages": [{"role": "user", "content": f"Generate an image: {PROMPT}"}],
    })
    msg = (data.get("choices") or [{}])[0].get("message", {})
    # 部分中转站将图片放在 images 字段
    for img in msg.get("images") or []:
        url = (img.get("image_url") or {}).get("url", "")
        if url:
            return _decode_url(url)
    content = msg.get("content")
    if isinstance(content, list):
        content = " ".join(json.dumps(p) for p in content)
    content = content or ""
    m = re.search(r"data:image/[a-zA-Z]+;base64,([A-Za-z0-9+/=]+)", content)
    if m:
        return base64.b64decode(m.group(1))
    m = re.search(r"https?://[^\s)\"']+\.(?:png|jpg|jpeg|webp)[^\s)\"']*", content)
    if m:
        return _download(m.group(0))
    raise RelayError(f"chat 接口未返回图片: {content[:300]}")


def _decode_url(url: str) -> bytes:
    """解析 data URL 或普通 URL"""
    if url.startswith("data:"):
        return base64.b64decode(url.split(",", 1)[1])
    return _download(url)


def generate(n: int) -> None:
    """生成 n 张候选 Logo"""
    # 默认使用之前对话中用过的中转站
    base = _env("RELAY_BASE_URL", "https://www.mirtop.online/v1").rstrip("/")
    key = _env("RELAY_API_KEY")
    model = os.environ.get("RELAY_IMAGE_MODEL", "").strip() or "gemini-2.5-flash-image"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"中转站: {base}  模型: {model}")
    for i in range(1, n + 1):
        try:
            try:
                raw = _via_images_api(base, key, model)
            except RelayError as e:
                print(f"[{i}] images 接口失败，改用 chat 接口：{e}")
                raw = _via_chat_api(base, key, model)
        except RelayError as e:
            print(f"[{i}] 生成失败：{e}")
            continue
        path = OUT_DIR / f"logo_candidate_{i}.png"
        with Image.open(BytesIO(raw)) as img:
            img.save(path, "PNG")
        print(f"[{i}] 已保存 {path}")


def apply(src: str) -> None:
    """将候选图居中裁成正方形、缩放到 1024x1024、去除透明通道后写入 iOS AppIcon"""
    with Image.open(src) as img:
        img = img.convert("RGBA")
        side = min(img.size)
        left, top = (img.width - side) // 2, (img.height - side) // 2
        img = img.crop((left, top, left + side, top + side)).resize((1024, 1024), Image.LANCZOS)
        # App Store 要求图标不能含 alpha 通道，用主题深色底合成
        canvas = Image.new("RGB", img.size, BG_COLOR)
        canvas.paste(img, mask=img.split()[3])
        canvas.save(IOS_ICON, "PNG")
    print(f"已写入 iOS 图标: {IOS_ICON}")


def main() -> None:
    parser = argparse.ArgumentParser(description="TransForge Logo 生成与应用")
    sub = parser.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate", help="通过中转站生成候选 Logo")
    g.add_argument("--n", type=int, default=3, help="候选数量")
    a = sub.add_parser("apply", help="应用候选图为 iOS AppIcon")
    a.add_argument("src", help="候选图路径")
    args = parser.parse_args()
    if args.cmd == "generate":
        generate(args.n)
    else:
        apply(args.src)


if __name__ == "__main__":
    main()
