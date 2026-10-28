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
const yml = ["../.github/workflows/ios.yml", "../ci/ios.yml"].find((p) => fs.existsSync(p));
ok(yml, "缺少 .github/workflows/ios.yml");

if (fail.length > 0) {
  console.error("iOS 自检失败:\n - " + fail.join("\n - "));
  process.exit(1);
}
console.log(`iOS 自检通过 (${yml})`);
