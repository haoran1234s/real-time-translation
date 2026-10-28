# -*- coding: utf-8 -*-
"""
多通道高速机器翻译引擎模块 (TranslationManager)
支持：
1. Google 免 Key 极速机器翻译（开箱即用）
2. 百度翻译通用 API（MD5 签名，整屏单次合并请求）
3. 腾讯云机器翻译 TMT（TC3-HMAC-SHA256 标准签名，整屏批量翻译）
内置 LRU 文本去重缓存，避免相同屏幕文本重复请求 API。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import random
import time
from collections import OrderedDict
from datetime import datetime, timezone
from typing import List, Dict, Any, Tuple
import urllib.parse
import httpx


class TextCache:
    """线程安全的轻量 LRU 翻译结果去重缓存器"""

    def __init__(self, max_size: int = 1000) -> None:
        """
        初始化缓存器
        :param max_size: 最大缓存条目数
        """
        self.max_size = max_size
        self.store: OrderedDict[str, str] = OrderedDict()

    def make_key(self, engine: str, source_lang: str, target_lang: str, text: str) -> str:
        """生成唯一缓存键"""
        return f"{engine}:{source_lang}:{target_lang}:{text.strip()}"

    def get(self, engine: str, source_lang: str, target_lang: str, text: str) -> str | None:
        """获取已缓存的译文"""
        key = self.make_key(engine, source_lang, target_lang, text)
        if key in self.store:
            self.store.move_to_end(key)
            return self.store[key]
        return None

    def set(self, engine: str, source_lang: str, target_lang: str, text: str, translated: str) -> None:
        """写入缓存并在超限时淘汰最旧条目"""
        key = self.make_key(engine, source_lang, target_lang, text)
        self.store[key] = translated
        self.store.move_to_end(key)
        if len(self.store) > self.max_size:
            self.store.popitem(last=False)


class TranslationManager:
    """多引擎批量翻译调度管理器"""

    # 百度语言代码映射表
    BAIDU_LANG_MAP: Dict[str, str] = {
        "auto": "auto",
        "zh": "zh",
        "en": "en",
        "ja": "jp",
        "ko": "kor",
        "fr": "fra",
        "es": "spa",
        "de": "de",
        "ru": "ru"
    }

    # 腾讯云 TMT 语言代码映射表
    TENCENT_LANG_MAP: Dict[str, str] = {
        "auto": "auto",
        "zh": "zh",
        "en": "en",
        "ja": "ja",
        "ko": "ko",
        "fr": "fr",
        "es": "es",
        "de": "de",
        "ru": "ru"
    }

    # Google 语言代码映射表
    GOOGLE_LANG_MAP: Dict[str, str] = {
        "auto": "auto",
        "zh": "zh-CN",
        "en": "en",
        "ja": "ja",
        "ko": "ko",
        "fr": "fr",
        "es": "es",
        "de": "de",
        "ru": "ru"
    }

    def __init__(self) -> None:
        """初始化翻译管理器与缓存"""
        self.cache = TextCache(max_size=1500)

    def translate_batch(
        self,
        texts: List[str],
        config: Dict[str, Any],
        engine_override: str | None = None
    ) -> Tuple[List[str], str, int]:
        """
        对整屏识别出的多段文本进行单次合并批量翻译
        :param texts: 待翻译的原文列表
        :param config: 当前系统配置字典
        :param engine_override: 临时指定的翻译引擎名称
        :return: (译文列表, 实际使用的引擎名, 耗时毫秒数)
        """
        start_ts = time.perf_counter()
        if not texts:
            return [], engine_override or config.get("active_engine", "google"), 0

        engine = (engine_override or config.get("active_engine") or "google").lower()
        source_lang = config.get("source_lang", "auto")
        target_lang = config.get("target_lang", "zh")

        results: List[str] = [""] * len(texts)
        missing_indices: List[int] = []
        missing_texts: List[str] = []

        # 1. 先查 LRU 去重缓存
        for idx, raw_text in enumerate(texts):
            cleaned = raw_text.strip()
            if not cleaned:
                results[idx] = ""
                continue
            cached_val = self.cache.get(engine, source_lang, target_lang, cleaned)
            if cached_val is not None:
                results[idx] = cached_val
            else:
                missing_indices.append(idx)
                missing_texts.append(cleaned)

        # 如果全部命中缓存，直接返回
        if not missing_texts:
            elapsed_ms = int((time.perf_counter() - start_ts) * 1000)
            return results, engine, elapsed_ms

        # 2. 按所选引擎执行单次合并翻译，若所选引擎未配置密钥则优雅回退至 Google 免 Key 通道
        actual_engine = engine
        try:
            if engine == "baidu":
                baidu_cfg = config.get("baidu", {})
                if baidu_cfg.get("app_id") and baidu_cfg.get("app_key"):
                    translated_missing = self._translate_baidu(
                        missing_texts, source_lang, target_lang,
                        baidu_cfg["app_id"], baidu_cfg["app_key"]
                    )
                else:
                    actual_engine = "google"
                    translated_missing = self._translate_google(missing_texts, source_lang, target_lang)
            elif engine == "tencent":
                tencent_cfg = config.get("tencent", {})
                if tencent_cfg.get("secret_id") and tencent_cfg.get("secret_key"):
                    translated_missing = self._translate_tencent(
                        missing_texts, source_lang, target_lang,
                        tencent_cfg["secret_id"], tencent_cfg["secret_key"],
                        tencent_cfg.get("region", "ap-guangzhou")
                    )
                else:
                    actual_engine = "google"
                    translated_missing = self._translate_google(missing_texts, source_lang, target_lang)
            else:
                actual_engine = "google"
                translated_missing = self._translate_google(missing_texts, source_lang, target_lang)
        except Exception:
            # 当特定引擎网络波动时，尝试 Google 极速通道兜底保障不中断
            try:
                actual_engine = "google"
                translated_missing = self._translate_google(missing_texts, source_lang, target_lang)
            except Exception:
                translated_missing = list(missing_texts)

        # 3. 写回结果与缓存
        for sub_idx, orig_idx in enumerate(missing_indices):
            trans_str = translated_missing[sub_idx] if sub_idx < len(translated_missing) else missing_texts[sub_idx]
            results[orig_idx] = trans_str
            self.cache.set(actual_engine, source_lang, target_lang, missing_texts[sub_idx], trans_str)

        elapsed_ms = int((time.perf_counter() - start_ts) * 1000)
        return results, actual_engine, elapsed_ms

    def _translate_google(self, texts: List[str], source_lang: str, target_lang: str) -> List[str]:
        """
        调用 Google 极速免配置接口，使用特殊分隔符单次合并请求整屏文本
        """
        sl = self.GOOGLE_LANG_MAP.get(source_lang, "auto")
        tl = self.GOOGLE_LANG_MAP.get(target_lang, "zh-CN")

        # 使用换行符拼接整屏段落，一次 HTTP 请求完成所有框的翻译
        joined_query = "\n".join(t.replace("\n", " ") for t in texts)
        params = {
            "client": "gtx",
            "sl": sl,
            "tl": tl,
            "dt": "t",
            "q": joined_query
        }
        url = f"https://translate.googleapis.com/translate_a/single?{urllib.parse.urlencode(params)}"

        with httpx.Client(timeout=8.0, trust_env=False, headers={"User-Agent": "Mozilla/5.0"}) as client:
            resp = client.get(url)
            resp.raise_for_status()
            data = resp.json()

        # 解析返回的句子片段
        full_translated = "".join(part[0] for part in (data[0] or []) if part and part[0])
        lines = [line.strip() for line in full_translated.split("\n")]

        # 若行数完美对齐则直接返回，否则逐条确保 1:1 对应
        if len(lines) == len(texts):
            return lines

        output: List[str] = []
        with httpx.Client(timeout=8.0, trust_env=False, headers={"User-Agent": "Mozilla/5.0"}) as client:
            for item in texts:
                single_params = {"client": "gtx", "sl": sl, "tl": tl, "dt": "t", "q": item.replace("\n", " ")}
                single_url = f"https://translate.googleapis.com/translate_a/single?{urllib.parse.urlencode(single_params)}"
                r = client.get(single_url)
                if r.status_code == 200:
                    d = r.json()
                    output.append("".join(p[0] for p in (d[0] or []) if p and p[0]).strip())
                else:
                    output.append(item)
        return output

    def _translate_baidu(
        self,
        texts: List[str],
        source_lang: str,
        target_lang: str,
        app_id: str,
        app_key: str
    ) -> List[str]:
        """
        调用百度翻译通用 API（支持用 \\n 连接多段文本，返回 trans_result 数组天然按行对齐）
        """
        from_lang = self.BAIDU_LANG_MAP.get(source_lang, "auto")
        to_lang = self.BAIDU_LANG_MAP.get(target_lang, "zh")

        query_text = "\n".join(t.replace("\n", " ") for t in texts)
        salt = str(random.randint(32768, 65536))
        sign_raw = f"{app_id}{query_text}{salt}{app_key}"
        sign = hashlib.md5(sign_raw.encode("utf-8")).hexdigest()

        payload = {
            "q": query_text,
            "from": from_lang,
            "to": to_lang,
            "appid": app_id,
            "salt": salt,
            "sign": sign
        }

        with httpx.Client(timeout=8.0, trust_env=False) as client:
            resp = client.post(
                "https://fanyi-api.baidu.com/api/trans/vip/translate",
                data=payload,
                headers={"Content-Type": "application/x-www-form-urlencoded"}
            )
            resp.raise_for_status()
            body = resp.json()

        if "error_code" in body:
            raise RuntimeError(f"百度翻译 API 错误 ({body['error_code']}): {body.get('error_msg')}")

        trans_result = body.get("trans_result", [])
        dst_list = [item.get("dst", "").strip() for item in trans_result]
        if len(dst_list) == len(texts):
            return dst_list
        return [dst_list[i] if i < len(dst_list) else texts[i] for i in range(len(texts))]

    def _translate_tencent(
        self,
        texts: List[str],
        source_lang: str,
        target_lang: str,
        secret_id: str,
        secret_key: str,
        region: str = "ap-guangzhou"
    ) -> List[str]:
        """
        调用腾讯云机器翻译 TMT TextTranslateBatch 批量翻译接口（TC3-HMAC-SHA256 签名）
        """
        source = self.TENCENT_LANG_MAP.get(source_lang, "auto")
        target = self.TENCENT_LANG_MAP.get(target_lang, "zh")

        service = "tmt"
        host = "tmt.tencentcloudapi.com"
        action = "TextTranslateBatch"
        version = "2018-03-21"
        timestamp = int(time.time())
        date_str = datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y-%m-%d")

        payload_dict = {
            "Source": source,
            "Target": target,
            "ProjectId": 0,
            "SourceTextList": [t.replace("\n", " ") for t in texts]
        }
        payload_json = json.dumps(payload_dict, separators=(",", ":"), ensure_ascii=False)

        # Step 1: 拼接规范请求串
        canonical_headers = f"content-type:application/json; charset=utf-8\nhost:{host}\nx-tc-action:{action.lower()}\n"
        signed_headers = "content-type;host;x-tc-action"
        hashed_request_payload = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
        canonical_request = f"POST\n/\n\n{canonical_headers}\n{signed_headers}\n{hashed_request_payload}"

        # Step 2: 拼接待签名字符串
        algorithm = "TC3-HMAC-SHA256"
        credential_scope = f"{date_str}/{service}/tc3_request"
        hashed_canonical_request = hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()
        string_to_sign = f"{algorithm}\n{timestamp}\n{credential_scope}\n{hashed_canonical_request}"

        # Step 3: 计算签名
        def _hmac_sha256(key_bytes: bytes, msg: str) -> bytes:
            return hmac.new(key_bytes, msg.encode("utf-8"), hashlib.sha256).digest()

        secret_date = _hmac_sha256(("TC3" + secret_key).encode("utf-8"), date_str)
        secret_service = _hmac_sha256(secret_date, service)
        secret_signing = _hmac_sha256(secret_service, "tc3_request")
        signature = hmac.new(secret_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

        authorization = (
            f"{algorithm} Credential={secret_id}/{credential_scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        )

        headers = {
            "Authorization": authorization,
            "Content-Type": "application/json; charset=utf-8",
            "Host": host,
            "X-TC-Action": action,
            "X-TC-Timestamp": str(timestamp),
            "X-TC-Version": version,
            "X-TC-Region": region
        }

        with httpx.Client(timeout=8.0, trust_env=False) as client:
            resp = client.post(f"https://{host}", content=payload_json.encode("utf-8"), headers=headers)
            resp.raise_for_status()
            res_data = resp.json().get("Response", {})

        if "Error" in res_data:
            err = res_data["Error"]
            raise RuntimeError(f"腾讯云翻译错误 ({err.get('Code')}): {err.get('Message')}")

        target_list = res_data.get("TargetTextList", [])
        return [target_list[i] if i < len(target_list) else texts[i] for i in range(len(texts))]
