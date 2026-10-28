/**
 * 构建 Capacitor iOS 离线包静态目录 (dist/)
 * 自动将 /static/* 路径转换为相对路径 ./，并注入构建期环境变量（如百度翻译 API 密钥）
 */

import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const parentEnvPath = path.resolve(rootDir, "..", ".env");

// 若上层存在 .env 则加载到 process.env
if (fs.existsSync(parentEnvPath)) {
  const envContent = fs.readFileSync(parentEnvPath, "utf8");
  envContent.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return;
    const eqIdx = trimmed.indexOf("=");
    const k = trimmed.slice(0, eqIdx).trim();
    const v = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (k && v && !process.env[k]) {
      process.env[k] = v;
    }
  });
}

const distDir = path.join(rootDir, "dist");
fs.mkdirSync(distDir, { recursive: true });

// 1. 处理 index.html：将 /static/ 替换为相对路径 ./
const htmlRaw = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
const htmlDist = htmlRaw
  .replace(/href="\/static\/style\.css"/g, 'href="./style.css"')
  .replace(/src="\/static\/app\.js"/g, 'src="./app.js"');
fs.writeFileSync(path.join(distDir, "index.html"), htmlDist, "utf8");

// 2. 复制 style.css
fs.copyFileSync(path.join(rootDir, "style.css"), path.join(distDir, "style.css"));

// 3. 处理 app.js：注入预设配置常量（供 iOS 独立 .ipa 运行时免输入直接使用百度翻译）
const appJsRaw = fs.readFileSync(path.join(rootDir, "app.js"), "utf8");
const presetEnv = {
  BAIDU_APP_ID: process.env.BAIDU_TRANSLATE_APP_ID ?? "",
  BAIDU_SECRET_KEY: process.env.BAIDU_TRANSLATE_SECRET_KEY ?? ""
};
const injectedBanner = `window.__PRESET_ENV__ = ${JSON.stringify(presetEnv)};\n`;
fs.writeFileSync(path.join(distDir, "app.js"), injectedBanner + appJsRaw, "utf8");

console.log("[OK] dist/ 构建完成 (已适配 Capacitor iOS 独立运行包)");
