/**
 * Add missing rappers from the user's checklist (fans >= 20000).
 *   node scripts/add-wanted.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTISTS } from "../src/data/artists.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "../src/data/artists.js");
const API = process.env.NETEASE_API_BASE || "http://127.0.0.1:3000";
const MIN_FANS = 20000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WANTED = [
  { label: "姜云升", q: ["姜云升"] },
  { label: "小鬼王琳凯", q: ["Lil Ghost", "小鬼王琳凯", "王琳凯"] },
  { label: "加木", q: ["加木"] },
  { label: "Ice Paper", q: ["Ice Paper"] },
  { label: "贝贝李京泽", q: ["贝贝李京泽", "李京泽", "贝贝"] },
  { label: "罗言", q: ["罗言"] },
  { label: "Spylent", q: ["Spylent"] },
  { label: "KnowKnow", q: ["KnowKnow"] },
  { label: "幼稚园杀手", q: ["幼稚园杀手"] },
  { label: "宝石Gem", q: ["宝石Gem", "宝石老舅", "Gem"] },
  { label: "BigYear大年", q: ["BigYear大年", "BigYear", "大年"] },
  { label: "布瑞吉", q: ["布瑞吉Bridge", "布瑞吉"] },
  { label: "丁飞", q: ["HipHopMan丁飞", "丁飞HipHopMan", "丁飞"] },
  { label: "刘柏辛", q: ["刘柏辛Lexie", "刘柏辛"] },
  { label: "王澳楠EVE", q: ["王澳楠EVE", "王澳楠"] },
  { label: "张方钊", q: ["张方钊"] },
  { label: "蛋堡", q: ["蛋堡 Soft Lipa", "蛋堡"] },
  { label: "瘦子E.SO", q: ["瘦子E.SO", "E.SO"] },
  { label: "愚月", q: ["愚月FoolMoon", "愚月"] },
  { label: "于意", q: ["于意Yee", "于意"] },
  { label: "AY杨佬叁", q: ["AY杨佬叁", "杨佬叁"] },
  { label: "李尔新", q: ["李尔新"] },
  { label: "刘思鉴", q: ["刘思鉴"] },
  { label: "Lil Jet", q: ["Lil Jet陆政廷", "Lil Jet", "陆政廷"] },
  { label: "孟子坤", q: ["孟子坤"] },
  { label: "廖效浓", q: ["廖效浓"] },
  { label: "高天佐", q: ["高天佐Trouble.Z", "高天佐"] },
  { label: "贰万", q: ["贰万"] },
  { label: "西奥Sio", q: ["西奥Sio", "西奥"] },
  { label: "Subs张毅成", q: ["Subs张毅成", "张毅成Subs"] },
  { label: "圣代", q: ["圣代说唱", "圣代"] },
  { label: "江奈生", q: ["江奈生"] },
  { label: "夏之禹", q: ["夏之禹"] },
  { label: "Bsh-1", q: ["Bsh-1"] },
  { label: "Ash-1", q: ["Ash-1"] },
  { label: "极品贵公子", q: ["极品贵公子"] },
  { label: "kKECHO", q: ["kKECHO陈欣瑶", "kKECHO", "陈欣瑶"] },
  { label: "AA说唱", q: ["AA说唱"] },
  { label: "等一下就回家", q: ["等一下就回家"] },
  { label: "木秦", q: ["木秦"] },
  { label: "Gm仙", q: ["Gm仙", "Gm 仙"] },
  { label: "孤影杀手", q: ["孤影杀手"] },
  { label: "K.ila", q: ["K.ila"] },
  { label: "生番刘悦", q: ["生番spam", "生番刘悦", "spam刘悦"] },
  { label: "鱼翅Fin", q: ["鱼翅Fin", "鱼翅"] },
  { label: "小安迪", q: ["小安迪LilAndy", "小安迪"] },
  { label: "Feezy", q: ["Feezy直火帮", "Feezy"] },
  { label: "XZT", q: ["XZT直火帮", "XZT"] },
  { label: "Zinco", q: ["Zinco泥鳅", "Zinco"] },
  { label: "鬼卞", q: ["鬼卞"] },
  { label: "3Bangz", q: ["3Bangz"] },
  { label: "未来星B3Rich", q: ["未来星B3Rich", "B3Rich", "未来星"] },
  { label: "徐真真", q: ["徐真真"] },
  { label: "河南说唱之神", q: ["河南说唱之神"] },
  { label: "河北Ye", q: ["河北Ye"] },
  { label: "杀手耗", q: ["杀手耗"] },
  { label: "永彬Ryan.B", q: ["永彬Ryan.B", "Ryan.B", "永彬"] },
  { label: "梁老师Tsong", q: ["梁老师Tsong", "梁老师"] },
  { label: "高尔宣OSN", q: ["高尔宣OSN", "高尔宣"] },
  { label: "熊仔", q: ["熊仔"] },
  { label: "陈娴静", q: ["陈娴静"] },
  { label: "Majin", q: ["Majin说唱", "Majin"] },
  { label: "God Øne", q: ["God Øne", "God One"] },
  { label: "国蛋GorDoN", q: ["国蛋GorDoN", "国蛋"] },
  { label: "小春Kenzy", q: ["小春Kenzy", "Kenzy"] },
  { label: "大渊Muta", q: ["大渊Muta", "Muta顽童"] },
  { label: "莫梭", q: ["莫梭"] },
  { label: "阿茹汗", q: ["阿茹汗"] },
  { label: "巴音汗", q: ["巴音汗"] },
  { label: "八贼Buzzy", q: ["八贼Buzzy", "Buzzy"] },
  { label: "曲甲", q: ["你的大表哥曲甲", "曲甲"] },
  { label: "秃子2z", q: ["秃子2z", "2z秃子"] },
  { label: "王澳楠", q: ["王澳楠"] },
  { label: "李尔新CDC", q: ["李尔新"] },
];

function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "artist"
  );
}

function hiRes(url, size = 400) {
  if (!url) return "";
  if (url.includes("param=")) return url;
  return url.includes("?") ? `${url}&param=${size}y${size}` : `${url}?param=${size}y${size}`;
}

function guessTag(fans) {
  if (fans >= 500000) return "头部";
  if (fans >= 100000) return "高人气";
  if (fans >= 50000) return "新锐热门";
  return "两万粉+";
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·．._\-#]/g, "");
}

function nameScore(query, artistName) {
  const q = norm(query);
  const n = norm(artistName);
  if (!q || !n) return 0;
  if (n === q) return 100;
  if (n.includes(q) || q.includes(n)) return 80;
  let hit = 0;
  for (const t of q.match(/[\u4e00-\u9fff]+|[a-z0-9]+/gi) || []) {
    if (t.length >= 2 && n.includes(t.toLowerCase())) hit += 1;
  }
  return hit * 20;
}

function alreadyHave(name) {
  const n = norm(name);
  return ARTISTS.some((a) => {
    const x = norm(a.name);
    return x === n || x.includes(n) || n.includes(x);
  });
}

async function getJson(p) {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(API + p);
    if (res.status === 405 || res.status === 429 || res.status === 503) {
      await sleep(600 * (i + 1));
      continue;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }
  throw new Error("unavailable");
}

async function resolveOne(queries) {
  let best = null;
  for (const q of queries) {
    const data = await getJson(
      `/cloudsearch?keywords=${encodeURIComponent(q)}&type=100&limit=8`
    );
    const artists = data?.result?.artists || [];
    for (const a of artists) {
      const score = Math.max(...queries.map((qq) => nameScore(qq, a.name)));
      if (score < 50) continue;
      const fanData = await getJson(`/artist/follow/count?id=${a.id}`);
      const fans = Number(fanData?.data?.fansCnt || 0);
      await sleep(50);
      const row = { ...a, fans, score };
      if (!best || score > best.score || (score === best.score && fans > best.fans)) {
        best = row;
      }
    }
    await sleep(80);
    if (best && best.score >= 80 && best.fans >= MIN_FANS) break;
  }
  return best;
}

async function main() {
  const added = [];
  const skipped = [];
  const failed = [];

  for (const item of WANTED) {
    if (item.q.some((q) => alreadyHave(q)) || alreadyHave(item.label)) {
      skipped.push(item.label + " (already)");
      continue;
    }
    process.stdout.write(`+ ${item.label} ... `);
    try {
      const hit = await resolveOne(item.q);
      if (!hit) {
        console.log("MISS");
        failed.push(item.label + " (not found)");
        continue;
      }
      if (hit.fans < MIN_FANS) {
        console.log(`${hit.name} only ${hit.fans} fans — skip`);
        failed.push(`${item.label} => ${hit.name} (${hit.fans})`);
        continue;
      }
      if (alreadyHave(hit.name)) {
        console.log(`${hit.name} already`);
        skipped.push(item.label);
        continue;
      }
      console.log(`${hit.name} (${hit.fans}) score=${hit.score}`);
      added.push({
        id: slugify(hit.name),
        name: hit.name,
        search: hit.name,
        city: "全国",
        tag: guessTag(hit.fans),
        blurb: `网易云粉丝 ${hit.fans.toLocaleString("zh-CN")} · 热门 Top 50 可办赛。`,
        neteaseArtistId: hit.id,
        avatar: hiRes(hit.img1v1Url || hit.picUrl || "", 400),
        fans: hit.fans,
      });
    } catch (e) {
      console.log("ERR", e.message);
      failed.push(item.label + " ERR");
      await sleep(400);
    }
  }

  const used = new Set(ARTISTS.map((a) => a.id));
  for (const a of added) {
    let id = a.id;
    let n = 2;
    while (used.has(id)) id = `${a.id}-${n++}`;
    used.add(id);
    a.id = id;
  }

  const merged = [...ARTISTS, ...added].sort((a, b) => (b.fans || 0) - (a.fans || 0));
  const body = `/**
 * Chinese rap roster: NetEase fans >= ${MIN_FANS}.
 * Generated: ${new Date().toISOString()} · ${merged.length} artists
 */
export const ARTISTS = ${JSON.stringify(merged, null, 2)};

export function getArtist(id) {
  return ARTISTS.find((a) => a.id === id) || null;
}
`;
  fs.writeFileSync(OUT, body, "utf8");
  console.log(`\nAdded ${added.length}. Total ${merged.length}.`);
  console.log("Failed/skip low fans:");
  failed.forEach((f) => console.log(" ", f));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
