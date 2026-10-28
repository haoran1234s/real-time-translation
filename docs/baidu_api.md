# 百度通用文本翻译 API 配置与调用说明

## 1. 凭证信息

* **服务名称**：百度通用文本翻译 API（高级版）
* **每月免费额度**：100 万字符
* **QPS 限制**：10
* **APP ID**：见 `.env` 中的 `BAIDU_TRANSLATE_APP_ID`
* **密钥**：见 `.env` 中的 `BAIDU_TRANSLATE_SECRET_KEY`

> 注意：密钥属于敏感凭证，已存入项目根目录下的 `.env` 文件，并已通过 `.gitignore` 忽略，避免泄露至公开代码仓库。

---

## 2. API 调用规范

* **请求地址**：`https://fanyi-api.baidu.com/api/trans/vip/translate`
* **请求方式**：`GET` 或 `POST`
* **字符编码**：`UTF-8`

### 请求参数

| 参数名 | 必填 | 描述 | 示例值 |
| :--- | :--- | :--- | :--- |
| `q` | 是 | 待翻译文本（UTF-8 编码） | `hello` |
| `from` | 是 | 源语言（支持 `auto` 自动检测） | `auto` |
| `to` | 是 | 目标语言（如 `zh` 中文, `en` 英文） | `zh` |
| `appid` | 是 | APP ID | `20261028002708477` |
| `salt` | 是 | 随机数（任意数字或字符串） | `1435660288` |
| `sign` | 是 | 签名：`MD5(appid + q + salt + 密钥)` | 32位小写 MD5 |

### 签名计算公式
```text
sign = MD5(appid + q + salt + 密钥)
```
*注意：计算 MD5 时，拼接的字符串不要有任何多余空格或分隔符。*
