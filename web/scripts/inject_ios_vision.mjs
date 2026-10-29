/**
 * 在 `npx cap sync ios` 之后，把原生层源码 web/ios-native/AppDelegate.swift 复制到 Capacitor 生成的 iOS 工程中，
 * 并把百度翻译凭证占位符替换为构建期环境变量（用于苹果离线翻译不可用时的备选）。
 *
 * 原生层能力：Apple Vision OCR 桥接 + 持续自动翻译引擎（回环接收录屏扩展画面 → OCR → 翻译 → 画中画）。
 */

import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const srcPath = path.join(rootDir, "ios-native", "AppDelegate.swift");
const destPath = path.join(rootDir, "ios", "App", "App", "AppDelegate.swift");

if (!fs.existsSync(path.dirname(destPath))) {
  console.log("[SKIP] ios/App/App 尚未生成，跳过原生层注入");
  process.exit(0);
}
if (!fs.existsSync(srcPath)) {
  console.error(`[ERROR] 缺少原生层源码: ${srcPath}`);
  process.exit(1);
}

/**
 * 转义为 Swift 字符串字面量内容
 * @param {string} value 原始值
 * @returns {string} 转义后的值
 */
const escapeSwift = (value) => String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const swift = fs
  .readFileSync(srcPath, "utf8")
  .replace("__BAIDU_APP_ID__", escapeSwift(process.env.BAIDU_TRANSLATE_APP_ID))
  .replace("__BAIDU_SECRET_KEY__", escapeSwift(process.env.BAIDU_TRANSLATE_SECRET_KEY));

fs.writeFileSync(destPath, swift, "utf8");
console.log("[OK] 已注入原生层：Vision OCR + 持续自动翻译引擎（录屏扩展回环 + 画中画）");
