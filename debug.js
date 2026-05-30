// 探针：打印目录页真实结构，便于修正选择器
const { chromium } = require('playwright');
const path = require('path');

const BOOK_ID = process.env.BOOK_ID || '390809';
const BASE = 'https://69shuba.tw';
const INDEX_URL = `${BASE}/indexlist/${BOOK_ID}/`;
const OUT_DIR = path.resolve(__dirname, `book_${BOOK_ID}`);
const PROFILE_DIR = path.join(OUT_DIR, 'profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(4000);

  console.log('=== TITLE ===');
  console.log(await page.title());
  console.log('当前URL：', page.url());

  console.log('\n=== body 前 300 字 ===');
  console.log(await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 300) : '(no body)')));

  console.log('\n=== 全页 <a> 链接（按 href 去重，最多 40 条）===');
  const links = await page.$$eval('a', (as) => {
    const seen = new Set();
    const out = [];
    for (const a of as) {
      const href = a.getAttribute('href') || '';
      if (!href || seen.has(href)) continue;
      seen.add(href);
      out.push(`${href}\t| ${a.textContent.trim().slice(0, 20)}`);
    }
    return out;
  });
  console.log(`共 ${links.length} 个不同 href，列前 40：`);
  console.log(links.slice(0, 40).join('\n'));

  console.log('\n=== 可能的章节容器 ===');
  const containers = await page.evaluate(() => {
    const cands = ['#catalog', '.catalog', '.mulu', '#chapterList', '.book_list', '.list', 'ul'];
    return cands.map((sel) => {
      const el = document.querySelector(sel);
      return `${sel} -> ${el ? el.querySelectorAll('a').length + ' 个a' : '无'}`;
    });
  });
  console.log(containers.join('\n'));

  console.log('\n浏览器保持打开 8 秒...');
  await sleep(8000);
  await ctx.close();
  console.log('---PROBE DONE---');
})();
