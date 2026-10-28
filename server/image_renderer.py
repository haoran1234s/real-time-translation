# -*- coding: utf-8 -*-
"""
1:1 原位背景感知覆盖渲染器与内置演示样张生成器 (ImageRenderer)
负责：
1. 将识别并翻译后的文本块 1:1 渲染回原图对应坐标（自动抹除原文、自适应字号与多行折行），
   供 iOS「快捷指令」1 秒全屏 QuickLook 预览及 PC/移动端高清导出使用。
2. 生成高保真多场景外文演示样张，支持开箱即用的一键体验。
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import List, Dict, Any, Tuple
from PIL import Image, ImageDraw, ImageFont


class ImageRenderer:
    """1:1 原位文字替换与高清样张图像渲染器"""

    def __init__(self) -> None:
        """初始化渲染器并定位 Windows / macOS / Linux 系统高清中文字体"""
        self.font_path = self._find_system_cjk_font()

    def _find_system_cjk_font(self) -> str | None:
        """查找系统内置的高清无衬线中文字体（微软雅黑 / 黑体 / 苹方）"""
        candidates = [
            "C:/Windows/Fonts/msyhbd.ttc",
            "C:/Windows/Fonts/msyh.ttc",
            "C:/Windows/Fonts/simhei.ttf",
            "/System/Library/Fonts/PingFang.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
        ]
        for path_str in candidates:
            if Path(path_str).exists():
                return path_str
        return None

    def _get_font(self, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
        """加载指定字号的字体对象"""
        safe_size = max(11, min(96, int(size)))
        if self.font_path:
            try:
                return ImageFont.truetype(self.font_path, safe_size)
            except Exception:
                pass
        return ImageFont.load_default()

    def render_inplace_image(
        self,
        source_image: Image.Image,
        blocks: List[Dict[str, Any]]
    ) -> bytes:
        """
        在原图上 1:1 原位覆盖绘制译文，输出 PNG 字节流
        :param source_image: 原始截图
        :param blocks: 包含坐标、译文、采样背景色与前景色的文本块列表
        :return: 渲染后的 PNG 图像二进制数据
        """
        canvas = source_image.convert("RGBA")
        overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)

        for blk in blocks:
            translated_text = (blk.get("translated") or blk.get("original") or "").strip()
            if not translated_text:
                continue

            x = int(blk["x"])
            y = int(blk["y"])
            w = max(24, int(blk["w"]))
            h = max(18, int(blk["h"]))
            bg_hex = blk.get("bg_color", "#121214")
            fg_hex = blk.get("fg_color", "#f8fafc")

            # 解析色彩并赋予 96% 不透明度，彻底遮盖底部原文同时保留自然过渡
            bg_rgb = self._hex_to_rgb(bg_hex)
            fg_rgb = self._hex_to_rgb(fg_hex)

            pad_x = max(4, int(h * 0.12))
            pad_y = max(3, int(h * 0.10))
            box_rect = [
                max(0, x - pad_x),
                max(0, y - pad_y),
                min(canvas.width, x + w + pad_x),
                min(canvas.height, y + h + pad_y)
            ]
            radius = min(10, max(4, int(min(w, h) * 0.18)))

            # 绘制 100% 不透明的原图背景色遮罩彻底抹除原文
            draw.rounded_rectangle(
                box_rect,
                radius=radius,
                fill=(*bg_rgb, 255)
            )

            # 自适应计算能完美放入框内的最佳字号与折行文本
            font, wrapped_lines, line_height = self._fit_text_in_box(
                draw, translated_text, w + pad_x, h + pad_y, blk.get("line_count", 1)
            )

            total_text_h = len(wrapped_lines) * line_height
            curr_y = y + (h - total_text_h) / 2.0

            for line_str in wrapped_lines:
                draw.text(
                    (x + 2, curr_y),
                    line_str,
                    font=font,
                    fill=(*fg_rgb, 255)
                )
                curr_y += line_height

        combined = Image.alpha_composite(canvas, overlay).convert("RGB")
        with io.BytesIO() as buf:
            combined.save(buf, format="PNG", optimize=True)
            return buf.getvalue()

    def _fit_text_in_box(
        self,
        draw: ImageDraw.ImageDraw,
        text: str,
        box_w: int,
        box_h: int,
        orig_lines: int = 1
    ) -> Tuple[Any, List[str], float]:
        """根据目标矩形宽高自适应寻找最清晰且不溢出的字号与换行方案"""
        max_font_size = min(48, max(13, int(box_h / max(1, orig_lines) * 0.78)))
        min_font_size = 12

        for size in range(max_font_size, min_font_size - 1, -2):
            font = self._get_font(size)
            lines = self._wrap_text(draw, text, font, max(20, box_w - 4))
            line_h = size * 1.24
            if len(lines) * line_h <= box_h * 1.18:
                return font, lines, line_h

        fallback_font = self._get_font(min_font_size)
        fallback_lines = self._wrap_text(draw, text, fallback_font, max(20, box_w - 4))
        return fallback_font, fallback_lines, min_font_size * 1.2

    def _wrap_text(
        self,
        draw: ImageDraw.ImageDraw,
        text: str,
        font: Any,
        max_width: int
    ) -> List[str]:
        """按像素宽度对中英文混合字符串进行自动折行"""
        lines: List[str] = []
        current_line = ""
        for ch in text:
            test_line = current_line + ch
            bbox = draw.textbbox((0, 0), test_line, font=font)
            line_w = bbox[2] - bbox[0]
            if line_w <= max_width or not current_line:
                current_line = test_line
            else:
                lines.append(current_line)
                current_line = ch
        if current_line:
            lines.append(current_line)
        return lines or [text]

    def _hex_to_rgb(self, hex_str: str) -> Tuple[int, int, int]:
        """将 #RRGGBB 转换为 (R, G, B) 元组"""
        clean = hex_str.lstrip("#")
        if len(clean) == 6:
            return int(clean[0:2], 16), int(clean[2:4], 16), int(clean[4:6], 16)
        return 18, 18, 20

    def create_demo_mobile_screen(self) -> Image.Image:
        """
        生成一张高清 iOS 外文旅行与社交复合屏幕截图（750 x 1334）
        用于首次打开工作台或点击「加载演示画面」时直接走真实 OCR + 翻译全链路
        """
        w, h = 750, 1334
        img = Image.new("RGB", (w, h), (15, 17, 23))
        draw = ImageDraw.Draw(img)

        # 1. 顶部旅行海景横幅卡片背景 (渐变深海蓝到暖霞色)
        for y_pos in range(60, 560):
            ratio = (y_pos - 60) / 500.0
            r = int(18 + ratio * 38)
            g = int(42 + ratio * 48)
            b = int(68 + ratio * 32)
            draw.line([(40, y_pos), (w - 40, y_pos)], fill=(r, g, b))

        draw.rounded_rectangle([40, 60, w - 40, 560], radius=28, outline=(56, 72, 96), width=2)

        # 绘制清晰高对比度英文文本供 Windows OCR 识别
        f_tag = self._get_font(22)
        f_hero = self._get_font(48)
        f_sub = self._get_font(24)
        f_sec = self._get_font(30)
        f_body = self._get_font(23)

        # 块 1: 地点胶囊
        draw.rounded_rectangle([76, 110, 340, 156], radius=12, fill=(16, 28, 44))
        draw.text((92, 118), "Amalfi Coast, Italy", font=f_tag, fill=(248, 250, 252))

        # 块 2: 大标题 (3行紧凑段落)
        draw.text((76, 185), "Discover", font=f_hero, fill=(255, 255, 255))
        draw.text((76, 245), "Your Next", font=f_hero, fill=(255, 255, 255))
        draw.text((76, 305), "Adventure", font=f_hero, fill=(255, 255, 255))

        # 块 3: 副标题 (2行段落)
        draw.text((76, 390), "Explore the world, one trip", font=f_sub, fill=(226, 232, 240))
        draw.text((76, 426), "at a time with expert guides.", font=f_sub, fill=(226, 232, 240))

        # 块 4: 搜索栏
        draw.rounded_rectangle([40, 595, w - 40, 668], radius=18, fill=(24, 26, 34), outline=(46, 50, 64), width=2)
        draw.text((80, 616), "Search destinations and hotels", font=f_sub, fill=(210, 218, 230))

        # 块 5 & 6: 分类快捷卡片
        draw.rounded_rectangle([40, 700, 358, 795], radius=18, fill=(24, 27, 36), outline=(45, 51, 66), width=1)
        draw.text((74, 732), "Luxury Hotels", font=f_sec, fill=(248, 250, 252))

        draw.rounded_rectangle([392, 700, w - 40, 795], radius=18, fill=(24, 27, 36), outline=(45, 51, 66), width=1)
        draw.text((426, 732), "Direct Flights", font=f_sec, fill=(248, 250, 252))

        # 块 7: 热门目的地标题
        draw.text((48, 835), "Popular Destinations", font=f_sec, fill=(248, 250, 252))

        # 块 8: 底部外文推文/评论卡片（浅色高对比卡片，测试浅底深字原位覆盖效果）
        draw.rounded_rectangle([40, 895, w - 40, 1120], radius=22, fill=(241, 245, 249))
        draw.text((74, 936), "The coastal train leaves every", font=f_body, fill=(15, 23, 42))
        draw.text((74, 982), "morning at eight. Book your", font=f_body, fill=(15, 23, 42))
        draw.text((74, 1028), "window seat early for the trip.", font=f_body, fill=(15, 23, 42))

        # 块 9: 底部操作按钮
        draw.rounded_rectangle([40, 1175, w - 40, 1265], radius=20, fill=(16, 185, 129))
        draw.text((215, 1204), "Reserve Instant Pass", font=f_sec, fill=(9, 9, 11))

        return img
