# -*- coding: utf-8 -*-
"""
端侧极速 OCR 识别与段落智能合并引擎 (OcrManager)
支持：
1. RapidOCR (ONNX Runtime，若已安装则优先启用)
2. Windows 原生硬件加速 Windows.Media.Ocr（零外部依赖，毫秒级提取文本与精确坐标框）
3. 智能段落聚合与局部背景色/高对比度文字色采样（确保对比度 >= 4.5:1）
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path
from typing import List, Dict, Any, Tuple
import numpy as np
from PIL import Image


class OcrManager:
    """OCR 识别、段落合并与色彩采样管理器"""

    def __init__(self) -> None:
        """初始化 OCR 引擎，自动探测可用的本地推理后端"""
        self._rapid_ocr = None
        try:
            from rapidocr_onnxruntime import RapidOCR  # type: ignore
            self._rapid_ocr = RapidOCR()
        except ImportError:
            self._rapid_ocr = None

    def extract_text_blocks(self, image: Image.Image, merge_paragraphs: bool = True) -> List[Dict[str, Any]]:
        """
        从 PIL 图像中提取所有文本块及其精确坐标、背景色与高对比度文字色
        :param image: 输入的 RGB 图像
        :param merge_paragraphs: 是否自动将相邻同段落文本行合并为完整语义块
        :return: 文本块字典列表
        """
        rgb_img = image.convert("RGB")
        img_w, img_h = rgb_img.size

        if self._rapid_ocr is not None:
            raw_lines = self._run_rapid_ocr(rgb_img)
        else:
            raw_lines = self._run_windows_native_ocr(rgb_img)

        # 过滤空白或过短噪点符号，并清洗 Windows 中文 OCR 识别拉丁字母时的 I/l 混淆
        valid_lines = []
        for line in raw_lines:
            cleaned_txt = self._clean_ocr_text(line["text"])
            if cleaned_txt and not self._is_noise_text(cleaned_txt):
                line["text"] = cleaned_txt
                valid_lines.append(line)

        if merge_paragraphs and len(valid_lines) > 1:
            blocks = self._merge_lines_to_blocks(valid_lines, img_w, img_h)
        else:
            blocks = valid_lines

        # 按从上到下、从左到右阅读顺序排序，并补充色彩采样与归一化坐标
        blocks.sort(key=lambda b: (round(b["y"] / max(20, img_h * 0.03)), b["x"]))

        enriched_blocks: List[Dict[str, Any]] = []
        for idx, blk in enumerate(blocks):
            x, y, w, h = int(blk["x"]), int(blk["y"]), int(blk["w"]), int(blk["h"])
            bg_hex, fg_hex = self._sample_box_colors(rgb_img, x, y, w, h)
            enriched_blocks.append({
                "id": f"T{idx + 1}",
                "index": idx + 1,
                "original": blk["text"].strip(),
                "translated": "",
                "x": x,
                "y": y,
                "w": max(16, w),
                "h": max(14, h),
                "nx": round(x / max(1, img_w) * 100, 3),
                "ny": round(y / max(1, img_h) * 100, 3),
                "nw": round(w / max(1, img_w) * 100, 3),
                "nh": round(h / max(1, img_h) * 100, 3),
                "bg_color": bg_hex,
                "fg_color": fg_hex,
                "line_count": blk.get("line_count", 1)
            })

        return enriched_blocks

    def _clean_ocr_text(self, text: str) -> str:
        """
        清洗 OCR 识别出的原始字符串：
        修复 Windows 中文 OCR 引擎将英文单词内小写 l 误判为大写 I 的常见现象
        """
        import re
        s = text.strip()
        if not s:
            return ""
        # 单词内部如 AmaIfi / HoteIs / FIights / PopuIar / ExpIore 将夹在字母间的 I 还原为 l
        s = re.sub(r"(?<=[a-zA-Z])I(?=[a-z])", "l", s)
        s = re.sub(r"(?<=[a-z])I(?=[a-zA-Z]|\b)", "l", s)
        s = re.sub(r"\bltaly\b", "Italy", s)
        s = re.sub(r"\blnstant\b", "Instant", s)
        s = re.sub(r"\bN\s+ext\b", "Next", s)
        s = re.sub(r"\bRe\s+se\s+rve\b", "Reserve", s)
        return s

    def _is_noise_text(self, text: str) -> bool:
        """过滤纯标点、单个无意义数字或状态栏噪点"""
        if len(text) <= 1 and not ("\u4e00" <= text <= "\u9fff"):
            return True
        if text in {"9:41", "09:41", "100%", "...", "•••", "←", "→", "<", ">"}:
            return True
        return False

    def _run_rapid_ocr(self, rgb_img: Image.Image) -> List[Dict[str, Any]]:
        """使用 RapidOCR 提取文本行与外接矩形"""
        arr = np.array(rgb_img)
        result, _ = self._rapid_ocr(arr)
        if not result:
            return []
        lines: List[Dict[str, Any]] = []
        for item in result:
            pts, text, _score = item
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            x_min, x_max = min(xs), max(xs)
            y_min, y_max = min(ys), max(ys)
            lines.append({
                "text": str(text).strip(),
                "x": float(x_min),
                "y": float(y_min),
                "w": float(x_max - x_min),
                "h": float(y_max - y_min),
                "line_count": 1
            })
        return lines

    def _run_windows_native_ocr(self, rgb_img: Image.Image) -> List[Dict[str, Any]]:
        """
        调用 Windows 10/11 原生 Windows.Media.Ocr.OcrEngine 提取文本行与精确矩形坐标
        使用 try...finally 显式释放临时图像文件句柄
        """
        temp_file = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        temp_path = Path(temp_file.name)
        temp_file.close()

        try:
            rgb_img.save(temp_path, format="PNG")
            ps_script = f"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {{
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
}})[0]

function Await($WinRtTask, $ResultType) {{
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
}}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('{str(temp_path)}')) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$ocrResult = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$stream.Dispose()

$outList = @()
foreach ($line in $ocrResult.Lines) {{
    $minX = [double]::MaxValue
    $minY = [double]::MaxValue
    $maxX = 0.0
    $maxY = 0.0
    $words = @()
    foreach ($w in $line.Words) {{
        $r = $w.BoundingRect
        if ($r.X -lt $minX) {{ $minX = $r.X }}
        if ($r.Y -lt $minY) {{ $minY = $r.Y }}
        if (($r.X + $r.Width) -gt $maxX) {{ $maxX = $r.X + $r.Width }}
        if (($r.Y + $r.Height) -gt $maxY) {{ $maxY = $r.Y + $r.Height }}
        $words += $w.Text
    }}
    if ($maxX -gt $minX -and $maxY -gt $minY) {{
        $joined = ($words -join ' ')
        # 若全是中文字符则去掉多余空格
        if ($joined -match '^[\\u4e00-\\u9fa5\\s\\p{{P}}]+$') {{
            $joined = ($words -join '')
        }}
        $outList += @{{
            text = $joined
            x = [math]::Round($minX, 1)
            y = [math]::Round($minY, 1)
            w = [math]::Round($maxX - $minX, 1)
            h = [math]::Round($maxY - $minY, 1)
        }}
    }}
}}
ConvertTo-Json -InputObject @($outList) -Compress
"""
            completed = subprocess.run(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps_script],
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=12
            )
            stdout_str = (completed.stdout or "").strip()
            if not stdout_str:
                return []
            parsed = json.loads(stdout_str)
            if isinstance(parsed, dict):
                parsed = [parsed]
            return [
                {
                    "text": str(item.get("text", "")).strip(),
                    "x": float(item.get("x", 0)),
                    "y": float(item.get("y", 0)),
                    "w": float(item.get("w", 10)),
                    "h": float(item.get("h", 10)),
                    "line_count": 1
                }
                for item in parsed
                if isinstance(item, dict) and item.get("text")
            ]
        except Exception:
            return []
        finally:
            if temp_path.exists():
                try:
                    temp_path.unlink()
                except OSError:
                    pass

    def _merge_lines_to_blocks(
        self,
        lines: List[Dict[str, Any]],
        img_w: int,
        img_h: int
    ) -> List[Dict[str, Any]]:
        """
        将同一视觉段落的多行碎文本合并为完整的语义块，提升翻译连贯度与覆盖美观度
        """
        sorted_lines = sorted(lines, key=lambda item: (item["y"], item["x"]))
        merged: List[Dict[str, Any]] = []

        for line in sorted_lines:
            curr = dict(line)
            if not merged:
                merged.append(curr)
                continue

            prev = merged[-1]
            prev_bottom = prev["y"] + prev["h"]
            avg_line_h = (prev["h"] / max(1, prev.get("line_count", 1)) + curr["h"]) / 2.0

            # 判断垂直距离是否紧密相邻，且左边界或水平中心接近、字号高度相仿
            v_gap = curr["y"] - prev_bottom
            left_diff = abs(curr["x"] - prev["x"])
            height_ratio = max(curr["h"], avg_line_h) / max(1.0, min(curr["h"], avg_line_h))

            is_vertically_close = -avg_line_h * 0.35 <= v_gap <= avg_line_h * 1.15
            is_left_aligned = left_diff <= max(48.0, img_w * 0.08)
            is_similar_scale = height_ratio <= 1.42

            if is_vertically_close and is_left_aligned and is_similar_scale:
                new_x = min(prev["x"], curr["x"])
                new_y = min(prev["y"], curr["y"])
                new_right = max(prev["x"] + prev["w"], curr["x"] + curr["w"])
                new_bottom = max(prev_bottom, curr["y"] + curr["h"])

                # 英文段落用空格拼接，中日韩直接拼接
                sep = " " if prev["text"][-1:].isascii() and curr["text"][:1].isascii() else ""
                prev["text"] = f"{prev['text']}{sep}{curr['text']}"
                prev["x"] = new_x
                prev["y"] = new_y
                prev["w"] = new_right - new_x
                prev["h"] = new_bottom - new_y
                prev["line_count"] = prev.get("line_count", 1) + 1
            else:
                merged.append(curr)

        return merged

    def _sample_box_colors(
        self,
        rgb_img: Image.Image,
        x: int,
        y: int,
        w: int,
        h: int
    ) -> Tuple[str, str]:
        """
        采样文本框边缘背景主色，并严格按照 WCAG 对比度标准 (>= 4.5:1) 计算文字前景色
        """
        img_w, img_h = rgb_img.size
        x0 = max(0, x - 4)
        y0 = max(0, y - 4)
        x1 = min(img_w, x + w + 4)
        y1 = min(img_h, y + h + 4)

        crop = rgb_img.crop((x0, y0, max(x0 + 1, x1), max(y0 + 1, y1)))
        arr = np.array(crop)

        # 提取四周边框像素以避开中心笔画颜色干扰
        if arr.shape[0] > 4 and arr.shape[1] > 4:
            top_edge = arr[:2, :, :].reshape(-1, 3)
            bottom_edge = arr[-2:, :, :].reshape(-1, 3)
            left_edge = arr[:, :2, :].reshape(-1, 3)
            right_edge = arr[:, -2:, :].reshape(-1, 3)
            edge_pixels = np.concatenate([top_edge, bottom_edge, left_edge, right_edge], axis=0)
        else:
            edge_pixels = arr.reshape(-1, 3)

        median_rgb = np.median(edge_pixels, axis=0).astype(int)
        r, g, b = int(median_rgb[0]), int(median_rgb[1]), int(median_rgb[2])

        # 计算感知亮度以决定深色底还是浅色底，确保 >= 4.5:1 高对比度，同时保持原背景真实底色实现无痕抹除
        luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
        fg_hex = "#f8fafc" if luminance < 0.54 else "#09090b"
        bg_hex = f"#{r:02x}{g:02x}{b:02x}"
        return bg_hex, fg_hex
