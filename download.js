// 69shuba 小说下载器（命令行版）
// 用真实浏览器内核(Playwright/Chromium)绕过 Cloudflare，限速 + 断点续传。
//
// 用法：
//   node download.js <目录页URL> [选项]
//   node download.js https://69shuba.tw/indexlist/390809/ --start 88 --headless
//
// 选项：
//   -u, --url <url>     目录页链接（也可作为第一个位置参数传入）
//   -s, --start <n>     从第 n 章开始下载（默认 1）
//   -e, --end <n>       下载到第 n 章为止（默认最后一章）
//       --headless      隐藏窗口后台运行（默认显示 Chrome 窗口，便于手动过验证）
//       --min <ms>      每章最小间隔毫秒（默认 8000）
//       --max <ms>      每章最大间隔毫秒（默认 20000）
//   -o, --out <dir>     输出目录（默认 ./book_<id>）
//   -h, --help          显示帮助
const { chromium } = require('playwright');
const { parseArgs } = require('util');
const fs = require('fs');
const path = require('path');

// ---------- 解析命令行 ----------
let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: 'string', short: 'u' },
      start: { type: 'string', short: 's' },
      end: { type: 'string', short: 'e' },
      headless: { type: 'boolean', default: true },
      'no-headless': { type: 'boolean', default: false },
      min: { type: 'string' },
      max: { type: 'string' },
      out: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
} catch (e) {
  console.error('参数错误：', e.message);
  process.exit(2);
}
const { values: opt, positionals } = parsed;

function printHelp() {
  console.log(`
69shuba 小说下载器（命令行版）

用法:
  node download.js <目录页URL> [选项]

示例:
  node download.js https://69shuba.tw/indexlist/390809/
  node download.js https://69shuba.tw/indexlist/390809/ --start 88
  node download.js https://69shuba.tw/indexlist/390809/ -s 50 -e 120 --headless

选项:
  -u, --url <url>     目录页链接（也可作为第一个位置参数）
  -s, --start <n>     从第 n 章开始下载（默认 1）
  -e, --end <n>       下载到第 n 章为止（默认最后一章）
      --no-headless   显示 Chrome 窗口（默认隐藏后台运行，便于手动过验证时用）
      --min <ms>      每章最小间隔毫秒（默认 8000）
      --max <ms>      每章最大间隔毫秒（默认 15000）
  -o, --out <dir>     输出目录（默认 ./book_<id>）
  -h, --help          显示帮助
`);
}

if (opt.help) { printHelp(); process.exit(0); }

const INPUT_URL = opt.url || positionals[0];
if (!INPUT_URL) {
  console.error('错误：必须提供目录页 URL。\n');
  printHelp();
  process.exit(2);
}

let BASE, BOOK_ID, INDEX_URL;
try {
  const u = new URL(INPUT_URL);
  BASE = u.origin;
  const m = u.pathname.match(/(\d{3,})/); // 取路径里第一段数字作为书 ID
  if (!m) throw new Error('URL 中未找到书籍 ID');
  BOOK_ID = m[1];
  // 归一化目录页起点：
  //  .tw 站  -> /indexlist/<id>/（分页，靠"下一页"翻）
  //  .com 站 -> /book/<id>/（单页列全部章节）
  if (/indexlist/.test(u.pathname)) {
    INDEX_URL = `${BASE}/indexlist/${BOOK_ID}/`;
  } else if (/\/book\//.test(u.pathname)) {
    INDEX_URL = `${BASE}/book/${BOOK_ID}/`;
  } else {
    INDEX_URL = INPUT_URL; // 其它形式：直接用传入 URL 作目录页
  }
} catch (e) {
  console.error('无法解析 URL：', e.message);
  process.exit(2);
}

const HEADLESS = opt['no-headless'] ? false : true; // 默认隐藏窗口；--no-headless 可显示
const MIN_DELAY = Number(opt.min) || 8000;
const MAX_DELAY = Number(opt.max) || 15000;
const START = Math.max(1, parseInt(opt.start || '1', 10) || 1);
const END = opt.end ? parseInt(opt.end, 10) : Infinity;
// 正文容器候选（不同站点不同）：.tw=#nr1 / .com=.txtnav
const CONTENT_SELS = ['#nr1', '.txtnav', '#nr'];

const OUT_DIR = path.resolve(opt.out || `book_${BOOK_ID}`);
const CH_DIR = path.join(OUT_DIR, 'chapters');
const PROFILE_DIR = path.join(OUT_DIR, 'profile');
const LIST_FILE = path.join(OUT_DIR, 'chapters.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a));
for (const d of [OUT_DIR, CH_DIR]) fs.mkdirSync(d, { recursive: true });

console.log(`目标书籍: ${BOOK_ID}  来源: ${BASE}`);
console.log(`章节范围: ${START} ~ ${END === Infinity ? '末章' : END}   窗口: ${HEADLESS ? '隐藏(headless)' : '显示'}   间隔: ${MIN_DELAY}~${MAX_DELAY}ms`);
console.log(`输出目录: ${OUT_DIR}\n`);

// ---------- 抓取逻辑 ----------
// 是否处于 CF JS 自动质询页（"请稍候…/Just a moment"，会自行解算，需等待而非退避）
async function isChallenge(page) {
  const title = (await page.title().catch(() => '')).toLowerCase();
  return /请稍候|just a moment|稍候|checking your browser/i.test(title);
}

// 检测是否被 Cloudflare / 风控硬拦截（需要退避或人工介入）
async function isBlocked(page) {
  const title = (await page.title().catch(() => '')).toLowerCase();
  if (/attention required|^document$/.test(title.trim())) return true;
  const txt = await page
    .evaluate(() => (document.body ? document.body.innerText.slice(0, 400) : ''))
    .catch(() => '');
  return /error:\s*403|token invalid|ip mismatch|verify you are human|访问频繁|稍后再试|拦截|人机验证/i.test(txt);
}

// 带重试 + 指数退避的访问
async function gotoSafe(page, url) {
  for (let attempt = 1; ; attempt++) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(rand(1500, 3000));
    // 先等 CF 的 JS 质询自动解算（最多约 30s）
    for (let i = 0; i < 15 && (await isChallenge(page)); i++) await sleep(2000);
    if (!(await isBlocked(page)) && !(await isChallenge(page))) return;
    const wait = Math.min(60000 * attempt, 10 * 60000);
    console.log(`  [拦截] 第 ${attempt} 次，等待 ${Math.round(wait / 1000)}s 后重试...`);
    console.log('  若长时间过不去，请在窗口里手动点一下验证后等待自动继续（如在 headless 模式被卡，请去掉 --headless 重跑）。');
    await sleep(wait);
  }
}

// 抓取章节目录（自动翻页）
async function fetchChapterList(page) {
  if (fs.existsSync(LIST_FILE)) {
    const cached = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
    console.log(`目录已缓存：共 ${cached.length} 章（如需重抓目录请删除 ${path.basename(LIST_FILE)}）`);
    return cached;
  }
  console.log('抓取目录...');
  const all = [];
  const seen = new Set();
  const visited = new Set();
  let url = INDEX_URL;
  let pageNo = 0;
  while (url && !visited.has(url)) {
    visited.add(url);
    pageNo++;
    await gotoSafe(page, url);
    const { items, next } = await page.evaluate((bookId) => {
      const re = new RegExp(`/(?:read|txt)/${bookId}/\\d+`); // 兼容 .tw(/read/) 与 .com(/txt/)
      const items = [...document.querySelectorAll('a')]
        .filter((a) => re.test(a.getAttribute('href') || ''))
        .map((a) => ({ title: a.textContent.trim(), url: a.href }));
      const nx = [...document.querySelectorAll('a')].find((a) => a.textContent.trim() === '下一页');
      return { items, next: nx ? nx.href : null };
    }, BOOK_ID);
    for (const it of items) {
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      all.push(it);
    }
    console.log(`  目录第 ${pageNo} 页：+${items.length} 章（累计 ${all.length}）`);
    url = next;
    if (url) await sleep(rand(MIN_DELAY, MAX_DELAY));
  }
  if (!all.length) throw new Error('未抓到章节链接，可能被拦截或选择器需调整（试 node debug.js 排查）');
  fs.writeFileSync(LIST_FILE, JSON.stringify(all, null, 2));
  console.log(`目录抓取完成：共 ${all.length} 章`);
  return all;
}

// 抓取单章正文（支持章节内"下一页"分页）
async function fetchChapter(page, ch) {
  let content = '';
  let url = ch.url;
  for (let guard = 0; url && guard < 12; guard++) {
    await gotoSafe(page, url);
    const data = await page.evaluate(({ sels, title }) => {
      let el = null;
      for (const s of sels) { el = document.querySelector(s); if (el) break; }
      if (el) {
        // 去掉正文容器内的标题/信息块/广告/脚本，保留纯正文
        el.querySelectorAll('h1, .txtinfo, .txtright, #txtright, .bottom-ad, .contentadv, script, ins, style').forEach((e) => e.remove());
      }
      let txt = el ? el.innerText.trim() : '';
      // .com 的 .txtnav 开头可能残留"章节名 日期 作者：xxx"行，按章节标题二次切除
      if (txt && title) {
        const idx = txt.indexOf(title);
        if (idx > -1 && idx < 80) txt = txt.slice(idx + title.length).trim();
      }
      const np = [...document.querySelectorAll('a')].find((a) => a.textContent.trim() === '下一页');
      return { txt, next: np ? np.href : null, title: document.title };
    }, { sels: CONTENT_SELS, title: ch.title.replace(/^第?\d+章?\s*/, '') });
    if (!data.txt) throw new Error('正文为空（容器可能变化）');
    content += (content ? '\n' : '') + data.txt;
    const m = data.title.match(/[（(]\s*(\d+)\s*\/\s*(\d+)\s*[）)]/);
    if (m && Number(m[1]) < Number(m[2]) && data.next) {
      url = data.next;
      await sleep(rand(3000, 7000));
    } else {
      url = null;
    }
  }
  return content;
}

async function launch() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { ctx, page };
}

function isCrash(msg) {
  return /Target closed|Target page.*closed|Connection closed|browser has disconnected|crash|Protocol error|Navigation failed because|context or browser/i.test(
    msg || ''
  );
}

// 用现有章节文件（按序号）合并成单一 txt
function mergeBook(total) {
  const files = fs
    .readdirSync(CH_DIR)
    .filter((f) => /^\d+\.txt$/.test(f))
    .sort();
  if (!files.length) return;
  const outTxt = path.join(OUT_DIR, `book_${BOOK_ID}.txt`);
  const parts = files.map((f) => fs.readFileSync(path.join(CH_DIR, f), 'utf8'));
  fs.writeFileSync(outTxt, parts.join(''), 'utf8');
  const done = files.length;
  if (done === total) console.log(`\n全部完成！已合并 ${done}/${total} 章 -> ${outTxt}`);
  else console.log(`\n已合并 ${done}/${total} 章（含本次范围）-> ${outTxt}\n未抓全的章节重跑可补抓。`);
}

(async () => {
  let { ctx, page } = await launch();
  const list = await fetchChapterList(page);

  const lo = START;
  const hi = Math.min(END, list.length);
  if (lo > list.length) {
    console.log(`起始章 ${lo} 超过总章数 ${list.length}，无可下载。`);
    await ctx.close();
    return;
  }
  console.log(`开始下载第 ${lo} ~ ${hi} 章（共 ${list.length} 章）\n`);

  for (let i = lo - 1; i < hi; i++) {
    const ch = list[i];
    const file = path.join(CH_DIR, `${String(i + 1).padStart(4, '0')}.txt`);
    if (fs.existsSync(file)) { continue; } // 断点续传：已存在则跳过

    let saved = false;
    for (let tries = 0; tries < 3 && !saved; tries++) {
      try {
        const content = await fetchChapter(page, ch);
        fs.writeFileSync(file, `\n\n${ch.title}\n\n${content}\n`);
        saved = true;
        console.log(`[${i + 1}/${list.length}] ✓ ${ch.title}`);
      } catch (e) {
        if (isCrash(e.message)) {
          console.log(`  [浏览器崩溃] ${e.message} —— 重启浏览器后重试本章...`);
          try { await ctx.close(); } catch {}
          await sleep(rand(3000, 6000));
          ({ ctx, page } = await launch());
          continue;
        }
        console.log(`[${i + 1}/${list.length}] ✗ ${ch.title} -> ${e.message}（跳过，重跑会补抓）`);
        break;
      }
    }
    await sleep(rand(MIN_DELAY, MAX_DELAY));
  }

  mergeBook(list.length);
  await ctx.close();
})().catch((e) => {
  console.error('运行出错：', e);
  process.exit(1);
});
