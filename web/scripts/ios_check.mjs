/**
 * iOS 打包前自检脚本（参照 Virtual-Fitness 规范）
 */

import fs from "node:fs";

const fail = [];
const ok = (cond, msg) => {
  if (!cond) fail.push(msg);
};

const cfg = JSON.parse(fs.readFileSync("capacitor.config.json", "utf8"));
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

ok(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(cfg.appId), "appId 必须是反向域名");
ok(cfg.webDir === "dist", "webDir 应为 dist");

const dv = (name) => (pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? "").replace(/[^\d.]/g, "").split(".")[0];
ok(
  dv("@capacitor/core") && dv("@capacitor/core") === dv("@capacitor/ios") && dv("@capacitor/ios") === dv("@capacitor/cli"),
  "core / ios / cli 主版本需一致"
);

ok(fs.existsSync("dist/index.html"), "缺少 dist/index.html，请先运行 npm run build");
ok(fs.existsSync("ios-native/AppDelegate.swift"), "缺少原生层源码 ios-native/AppDelegate.swift");
ok(fs.existsSync("ios-ext/TransForgeBroadcast/SampleHandler.swift"), "缺少录屏扩展源码 ios-ext/TransForgeBroadcast/SampleHandler.swift");
ok(fs.existsSync("ios-ext/TransForgeBroadcast/Info.plist"), "缺少录屏扩展 Info.plist");
ok(fs.existsSync("scripts/add_broadcast_ext.rb"), "缺少扩展注入脚本 scripts/add_broadcast_ext.rb");
// 原生层与扩展必须使用同一个回环端口
const port = (file) => (fs.readFileSync(file, "utf8").match(/NWEndpoint\.Port\s*=\s*(\d+)/) ?? [])[1];
ok(
  port("ios-native/AppDelegate.swift") && port("ios-native/AppDelegate.swift") === port("ios-ext/TransForgeBroadcast/SampleHandler.swift"),
  "主 App 与录屏扩展的回环端口不一致"
);
const yml = ["../.github/workflows/ios.yml", "../ci/ios.yml"].find((p) => fs.existsSync(p));
ok(yml, "缺少 .github/workflows/ios.yml");

if (fail.length > 0) {
  console.error("iOS 自检失败:\n - " + fail.join("\n - "));
  process.exit(1);
}
console.log(`iOS 自检通过 (${yml})`);
