# -*- coding: utf-8 -*-
"""
TransForge 实时屏幕 1:1 原位翻译服务端主入口 (FastAPI)
支持：
- iOS 快捷指令（轻点背面 / Action Button）1 秒原位覆盖直出 PNG
- 手机 / 电脑 PWA 1:1 坐标悬浮气泡与 T1~Tn 框选双向联动工作台
- Windows 电脑端一键截屏翻译与剪贴板粘贴翻译
- 百度翻译 API / 腾讯云机器翻译 TMT / Google 极速免配置三引擎切换
"""

from __future__ import annotations

import base64
import io
import socket
import time
from collections import deque
from pathlib import Path
from typing import Dict, Any, List
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageGrab

from config_manager import ConfigManager
from ocr_engine import OcrManager
from translators import TranslationManager
from image_renderer import ImageRenderer

BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = BASE_DIR / "config.json"
WEB_DIR = BASE_DIR / "web"

app = FastAPI(title="TransForge 1:1 In-Place Screen Translator", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

config_mgr = ConfigManager(CONFIG_PATH)
ocr_mgr = OcrManager()
trans_mgr = TranslationManager()
renderer = ImageRenderer()

# 双端实时同步历史队列（保存最近 10 次屏幕翻译会话，支持手机触发后电脑端实时同步）
session_history: deque[Dict[str, Any]] = deque(maxlen=10)


def get_lan_ip() -> str:
    """获取本机局域网 IPv4 地址，方便 iOS 手机在同一 Wi-Fi 下直接连接"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        sock.close()


def process_screen_image(
    pil_img: Image.Image,
    engine_override: str | None = None,
    source_lang_override: str | None = None,
    target_lang_override: str | None = None,
    source_device: str = "mobile"
) -> Dict[str, Any]:
    """
    核心屏幕翻译管线：
    图像输入 -> 端侧 OCR 与段落合并 -> 局部背景色采样 -> 整屏单次批量翻译 -> 1:1 原位图像合成
    """
    t0 = time.perf_counter()
    cfg = config_mgr.load_config()
    if source_lang_override:
        cfg["source_lang"] = source_lang_override
    if target_lang_override:
        cfg["target_lang"] = target_lang_override

    rgb_img = pil_img.convert("RGB")
    # 限制超大分辨率以保证毫秒级 OCR 速度
    max_side = 1600
    if max(rgb_img.width, rgb_img.height) > max_side:
        scale = max_side / float(max(rgb_img.width, rgb_img.height))
        new_size = (int(rgb_img.width * scale), int(rgb_img.height * scale))
        rgb_img = rgb_img.resize(new_size, Image.Resampling.LANCZOS)

    # 1. OCR 识别与智能段落合并
    ocr_start = time.perf_counter()
    blocks = ocr_mgr.extract_text_blocks(rgb_img, merge_paragraphs=True)
    ocr_ms = int((time.perf_counter() - ocr_start) * 1000)

    # 2. 整屏单次合并翻译
    originals = [b["original"] for b in blocks]
    translated_list, used_engine, trans_ms = trans_mgr.translate_batch(
        originals, cfg, engine_override=engine_override
    )

    for idx, blk in enumerate(blocks):
        blk["translated"] = translated_list[idx] if idx < len(translated_list) else blk["original"]

    # 3. 渲染 1:1 原位覆盖图像与原图 Base64
    rendered_png_bytes = renderer.render_inplace_image(rgb_img, blocks)
    with io.BytesIO() as raw_buf:
        rgb_img.save(raw_buf, format="PNG")
        original_b64 = base64.b64encode(raw_buf.getvalue()).decode("ascii")

    rendered_b64 = base64.b64encode(rendered_png_bytes).decode("ascii")
    total_ms = int((time.perf_counter() - t0) * 1000)

    session_data: Dict[str, Any] = {
        "session_id": f"s_{int(time.time() * 1000)}",
        "timestamp": time.strftime("%H:%M:%S"),
        "source_device": source_device,
        "width": rgb_img.width,
        "height": rgb_img.height,
        "engine": used_engine,
        "source_lang": cfg.get("source_lang", "auto"),
        "target_lang": cfg.get("target_lang", "zh"),
        "ocr_ms": ocr_ms,
        "trans_ms": trans_ms,
        "total_ms": total_ms,
        "blocks": blocks,
        "original_image": f"data:image/png;base64,{original_b64}",
        "rendered_image": f"data:image/png;base64,{rendered_b64}",
        "_raw_rendered_bytes": rendered_png_bytes
    }

    # 存入历史供双端同步（深拷贝去除二进制字段）
    history_item = {k: v for k, v in session_data.items() if k != "_raw_rendered_bytes"}
    session_history.appendleft(history_item)
    return session_data


@app.get("/api/info")
async def get_server_info() -> Dict[str, Any]:
    """获取服务端局域网连接信息与当前配置状态"""
    cfg = config_mgr.load_config()
    lan_ip = get_lan_ip()
    return {
        "lan_ip": lan_ip,
        "port": 8765,
        "shortcut_url": f"http://{lan_ip}:8765/api/ios-shortcut",
        "web_url": f"http://{lan_ip}:8765",
        "config": cfg,
        "engines_status": {
            "google": {"configured": True, "label": "Ready (免配置极速)"},
            "baidu": {
                "configured": bool(cfg.get("baidu", {}).get("app_id") and cfg.get("baidu", {}).get("app_key")),
                "label": "Connected" if (cfg.get("baidu", {}).get("app_id") and cfg.get("baidu", {}).get("app_key")) else "Not Configured"
            },
            "tencent": {
                "configured": bool(cfg.get("tencent", {}).get("secret_id") and cfg.get("tencent", {}).get("secret_key")),
                "label": "Connected" if (cfg.get("tencent", {}).get("secret_id") and cfg.get("tencent", {}).get("secret_key")) else "Not Configured"
            }
        }
    }


@app.post("/api/config")
async def update_config(request: Request) -> Dict[str, Any]:
    """更新翻译引擎密钥或语言偏好设置"""
    payload = await request.json()
    updated = config_mgr.save_config(payload)
    return {
        "ok": True,
        "config": updated,
        "engines_status": {
            "google": {"configured": True, "label": "Ready (免配置极速)"},
            "baidu": {
                "configured": bool(updated.get("baidu", {}).get("app_id") and updated.get("baidu", {}).get("app_key")),
                "label": "Connected" if (updated.get("baidu", {}).get("app_id") and updated.get("baidu", {}).get("app_key")) else "Not Configured"
            },
            "tencent": {
                "configured": bool(updated.get("tencent", {}).get("secret_id") and updated.get("tencent", {}).get("secret_key")),
                "label": "Connected" if (updated.get("tencent", {}).get("secret_id") and updated.get("tencent", {}).get("secret_key")) else "Not Configured"
            }
        }
    }


@app.post("/api/translate-image")
async def translate_image_api(request: Request) -> Dict[str, Any]:
    """
    接收前端上传/粘贴的 Base64 图片，返回坐标块与 1:1 原位覆盖结果
    """
    body = await request.json()
    b64_str = body.get("image_base64", "")
    if not b64_str:
        raise HTTPException(status_code=400, detail="缺少 image_base64 参数")

    if "," in b64_str:
        b64_str = b64_str.split(",", 1)[1]

    try:
        img_bytes = base64.b64decode(b64_str)
        with Image.open(io.BytesIO(img_bytes)) as pil_img:
            result = process_screen_image(
                pil_img,
                engine_override=body.get("engine"),
                source_lang_override=body.get("source_lang"),
                target_lang_override=body.get("target_lang"),
                source_device=body.get("source_device", "mobile")
            )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"图像处理失败: {str(exc)}")

    return {k: v for k, v in result.items() if k != "_raw_rendered_bytes"}


@app.post("/api/ios-shortcut")
async def ios_shortcut_endpoint(request: Request) -> Response:
    """
    iOS「快捷指令 (Shortcuts)」专属 1 秒原位覆盖接口：
    支持直接 POST 原始截图二进制流（File -> Screenshot）或 JSON Base64，
    直接返回渲染好 1:1 原位中文覆盖的 PNG 图片流，供 iOS「快速查看 (Quick Look)」全屏秒弹！
    """
    raw_body = await request.body()
    if not raw_body:
        raise HTTPException(status_code=400, detail="未收到截图数据")

    engine = request.query_params.get("engine")
    source_lang = request.query_params.get("from")
    target_lang = request.query_params.get("to")

    try:
        # 兼容 JSON 包装或直接二进制图片文件流
        if raw_body[:1] == b"{":
            import json
            data = json.loads(raw_body.decode("utf-8"))
            b64_part = data.get("image_base64", "")
            if "," in b64_part:
                b64_part = b64_part.split(",", 1)[1]
            raw_body = base64.b64decode(b64_part)

        with Image.open(io.BytesIO(raw_body)) as pil_img:
            result = process_screen_image(
                pil_img,
                engine_override=engine,
                source_lang_override=source_lang,
                target_lang_override=target_lang,
                source_device="ios-shortcut"
            )
            png_bytes = result["_raw_rendered_bytes"]
            return Response(content=png_bytes, media_type="image/png")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"iOS 快捷指令翻译失败: {str(exc)}")


@app.post("/api/capture-pc")
async def capture_pc_screen(request: Request) -> Dict[str, Any]:
    """
    Windows 电脑端一键截取当前屏幕并立即执行 1:1 原位覆盖翻译
    """
    try:
        body = await request.json()
    except Exception:
        body = {}

    try:
        captured = ImageGrab.grab()
        try:
            result = process_screen_image(
                captured,
                engine_override=body.get("engine"),
                source_lang_override=body.get("source_lang"),
                target_lang_override=body.get("target_lang"),
                source_device="desktop"
            )
        finally:
            captured.close()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"电脑屏幕截取失败: {str(exc)}")

    return {k: v for k, v in result.items() if k != "_raw_rendered_bytes"}


@app.post("/api/demo")
async def run_builtin_demo(request: Request) -> Dict[str, Any]:
    """
    生成内置高清 iOS 外文画面并执行真实 OCR + 真实翻译管线，用于开箱即用演示
    """
    try:
        body = await request.json()
    except Exception:
        body = {}

    demo_img = renderer.create_demo_mobile_screen()
    try:
        result = process_screen_image(
            demo_img,
            engine_override=body.get("engine"),
            source_lang_override=body.get("source_lang"),
            target_lang_override=body.get("target_lang"),
            source_device="mobile"
        )
    finally:
        demo_img.close()

    return {k: v for k, v in result.items() if k != "_raw_rendered_bytes"}


@app.get("/api/latest")
async def get_latest_session() -> Dict[str, Any]:
    """获取最近一次翻译会话（用于手机快捷指令触发后，电脑端画布实时同步刷新）"""
    if not session_history:
        return {"has_session": False}
    return {"has_session": True, "session": session_history[0]}


@app.get("/api/history")
async def get_history_list() -> Dict[str, Any]:
    """获取历史翻译记录列表"""
    return {"items": list(session_history)}


# 挂载前端静态资源
app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.get("/")
async def serve_index() -> FileResponse:
    """返回主工作台页面"""
    return FileResponse(str(WEB_DIR / "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8765, log_level="info")
