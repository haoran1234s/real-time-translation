# -*- coding: utf-8 -*-
"""
配置管理模块 (ConfigManager)
自动从项目根目录 .env 文件及环境变量中读取 BAIDU_TRANSLATE_APP_ID / BAIDU_TRANSLATE_SECRET_KEY，
并安全读写本地 config.json。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Dict, Any


class ConfigManager:
    """应用配置持久化管理器（优先读取 .env 中的百度翻译 API 配置）"""

    def __init__(self, config_path: Path) -> None:
        """
        初始化配置管理器并加载同级 .env 环境变量
        :param config_path: 配置文件存储路径
        """
        self.config_path = config_path
        self.env_path = config_path.parent / ".env"
        self._load_dotenv()

        env_baidu_id = os.environ.get("BAIDU_TRANSLATE_APP_ID", "").strip()
        env_baidu_key = os.environ.get("BAIDU_TRANSLATE_SECRET_KEY", "").strip()
        has_baidu_env = bool(env_baidu_id and env_baidu_key)

        self.default_config: Dict[str, Any] = {
            "active_engine": "baidu" if has_baidu_env else "google",
            "source_lang": "auto",
            "target_lang": "zh",
            "display_mode": "inplace",
            "baidu": {
                "app_id": env_baidu_id,
                "app_key": env_baidu_key
            },
            "tencent": {
                "secret_id": os.environ.get("TENCENT_SECRET_ID", "").strip(),
                "secret_key": os.environ.get("TENCENT_SECRET_KEY", "").strip(),
                "region": "ap-guangzhou"
            },
            "google": {
                "mirror_url": "https://translate.googleapis.com/translate_a/single"
            }
        }

    def _load_dotenv(self) -> None:
        """解析项目根目录下的 .env 文件并注入到当前进程环境变量"""
        if not self.env_path.exists():
            return
        try:
            with open(self.env_path, "r", encoding="utf-8") as file_handle:
                for raw_line in file_handle:
                    line = raw_line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, val = line.split("=", 1)
                    clean_key = key.strip()
                    clean_val = val.strip().strip("'\"")
                    if clean_key and clean_val and clean_key not in os.environ:
                        os.environ[clean_key] = clean_val
        except Exception:
            pass

    def load_config(self) -> Dict[str, Any]:
        """
        加载本地配置文件，若 .env 中已配置百度翻译 API 则自动补齐并激活
        :return: 完整配置字典
        """
        self._load_dotenv()
        merged = json.loads(json.dumps(self.default_config))

        if self.config_path.exists():
            try:
                with open(self.config_path, "r", encoding="utf-8") as file_handle:
                    saved_data = json.load(file_handle)
                    for key, val in saved_data.items():
                        if isinstance(val, dict) and isinstance(merged.get(key), dict):
                            merged[key] = {**merged[key], **val}
                        else:
                            merged[key] = val
            except Exception:
                pass

        # 若 config.json 中百度密钥为空而 .env 中存在，自动引用 .env 中的百度翻译密钥
        env_baidu_id = os.environ.get("BAIDU_TRANSLATE_APP_ID", "").strip()
        env_baidu_key = os.environ.get("BAIDU_TRANSLATE_SECRET_KEY", "").strip()
        if env_baidu_id and not merged["baidu"].get("app_id"):
            merged["baidu"]["app_id"] = env_baidu_id
        if env_baidu_key and not merged["baidu"].get("app_key"):
            merged["baidu"]["app_key"] = env_baidu_key

        return merged

    def save_config(self, new_config: Dict[str, Any]) -> Dict[str, Any]:
        """
        保存更新后的配置到本地文件
        :param new_config: 前端提交的新配置对象
        :return: 持久化后的完整配置字典
        """
        current = self.load_config()
        for key, val in new_config.items():
            if key in current:
                if isinstance(val, dict) and isinstance(current[key], dict):
                    current[key] = {**current[key], **val}
                else:
                    current[key] = val

        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.config_path, "w", encoding="utf-8") as file_handle:
            json.dump(current, file_handle, ensure_ascii=False, indent=2)
        return current
