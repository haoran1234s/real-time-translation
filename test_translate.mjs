import crypto from 'node:crypto';
import fs from 'node:fs';

// 读取 .env 配置
const envText = fs.readFileSync('.env', 'utf-8');
const env = Object.fromEntries(
  envText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const idx = line.indexOf('=');
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    })
);

const appid = env.BAIDU_TRANSLATE_APP_ID;
const key = env.BAIDU_TRANSLATE_SECRET_KEY;
const q = 'Hello, this is a real-time translation test!';
const from = 'en';
const to = 'zh';
const salt = Date.now().toString();

// 百度翻译签名：MD5(appid + q + salt + key)
const sign = crypto.createHash('md5').update(`${appid}${q}${salt}${key}`).digest('hex');

const params = new URLSearchParams({
  q,
  from,
  to,
  appid,
  salt,
  sign
});

try {
  const response = await fetch('https://fanyi-api.baidu.com/api/trans/vip/translate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  const result = await response.json();
  console.log('测试结果：', JSON.stringify(result, null, 2));
} catch (error) {
  console.error('调用异常：', error);
}
