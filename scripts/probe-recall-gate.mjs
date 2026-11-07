// 校准探针:中文为主的 recall-intent 嵌入门。
// 动机:上游 zh-Hans 正则组实测 13 题只中 4(memory-chain §Lane 2);翻译门撤于
// 2026-11-04(每条消息一次模型调用,~400ms)。本探针量的是第三条路:本地 bge-m3
// 嵌入一次消息(已在跑的 llama-server),与冻结例句库取 max cosine 当门。
// 运行:node scripts/probe-recall-gate.mjs [http://127.0.0.1:4748]
// 只读探针:不发指令前缀(与索引侧同路,对称相似);例句库与测试集分开,测泛化。
const BASE = process.argv[2] ?? "http://127.0.0.1:4748";

// 例句库(生产里冻结进 recall-intent-embed.ts 的那一份)。
const EXEMPLARS = [
  // en — 上游 14 条正则的句式改写
  "what did we decide about this?",
  "do you remember when we chose it?",
  "last time we talked about this",
  "previously we agreed on a plan",
  "what did I ask you to do before?",
  "have we discussed this already?",
  "summarize our past conversations",
  "remind me what we picked",
  "where did we leave off?",
  "earlier you said something about this",
  "what was our original goal?",
  "how did we solve this yesterday?",
  // zh
  "我们之前聊了什么？",
  "上次我们是怎么决定的？",
  "你还记得我说过什么吗？",
  "我们最开始是要做什么来着？",
  "我最开始让你做的是什么？",
  "之前的方案是哪个来着？",
  "上次我们做了什么？",
  "这个问题以前怎么讨论的？",
  "昨天我们说到哪了，再说一遍",
  "之前测试结果怎么样？",
  "我们选的是哪个模型？",
  "以前的结论还记得吗？",
  "这个我们之前配置过吗？",
  "刚才说的内容是什么？",
  "之前是怎么解决这个问题的？",
  "这类问题以前是怎么处理的？",
  // ja
  "前回何を話しましたか？",
  "覚えていますか？",
  "前にどう決めましたっけ？",
  // ko
  "지난번에 뭐 논의했죠?",
  "기억나세요?",
  // ru
  "что мы обсуждали вчера?",
  "напомни, что мы решили?",
  // es
  "¿qué hablamos antes?",
  "¿recuerdas lo que elegimos?",
  // fr
  "de quoi on a parlé ?",
  "tu te souviens de la dernière fois ?",
  // pt
  "o que a gente discutiu antes?",
  "você lembra o que decidimos?",
];

// 测试集 —— 正例(含两个已知漏网句式,均不在例句库里)
const POSITIVES = [
  ["zh", "我们之前讨论过向量模型吗？"],
  ["zh", "我最开始想做什么东西？"],
  ["zh", "一开始你打算做的是什么？"],
  ["zh", "我们现在在干什么？最初目标是什么来着"],
  ["zh", "上次那个 bug 是怎么修的来着？"],
  ["zh", "端口号定了吗？之前定的是哪个？"],
  ["zh", "之前我们为什么放弃那个方案来着"],
  ["zh", "这个我们聊过没有？"],
  ["zh", "上次跑到哪里了？"],
  ["zh", "我让你把 README 写成什么样的来着"],
  ["zh", "向量服务慢的时候我们最后用的什么办法"],
  ["zh", "我们最后选的哪个嵌入模型？"],
  ["zh", "之前的实验结果是什么着"],
  ["zh", "装机器的问题我之前问过吧？"],
  ["zh", "你还记得我更喜欢什么吗？"],
  ["en", "what did we decide about the port?"],
  ["en", "do you remember when we picked the database?"],
  ["en", "how did we fix this last time?"],
  ["en", "have we talked about authentication before?"],
  ["en", "remind me what I usually ask for"],
  ["ja", "この前決めたこと覚えてる？"],
  ["ko", "지난번에 결정했던 게 뭐였죠?"],
  ["ru", "мы это уже обсуждали?"],
  ["es", "¿qué decidimos la semana pasada?"],
];

// 测试集 —— 反例(日常编码指令与现在时提问;门必须安静)
const NEGATIVES = [
  ["zh", "修复登录页的样式 bug"],
  ["zh", "为什么构建失败了？"],
  ["zh", "把端口改成 4747"],
  ["zh", "重构索引模块，把它和 sqlite 解耦"],
  ["zh", "这天气怎么样"],
  ["zh", "这段代码是干什么的？"],
  ["zh", "git 装在哪里？"],
  ["zh", "现在跑的是哪个后端？"],
  ["zh", "帮我写一个提交信息"],
  ["zh", "记住:我喜欢用 tab 缩进"],
  ["zh", "这次改用 vulkan 后端"],
  ["zh", "把这个页面的布局弄合理一点"],
  ["en", "add a retry with exponential backoff to the client"],
  ["en", "run the tests and report the failures"],
  ["en", "remember to use pwsh, not cmd"],
  ["en", "why does the build fail?"],
  ["en", "where is git installed?"],
  ["en", "refactor this function"],
  ["en", "deploy the new version now"],
  ["en", "explain what this regex does"],
  ["fr", "traduis ce texte en anglais"],
  ["ja", "この関数をリファクタリングして"],
];

async function embed(text) {
  const started = Date.now();
  const res = await fetch(`${BASE}/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: text }),
  });
  if (!res.ok) throw new Error(`POST /embed ${res.status}`);
  const json = await res.json();
  return { vector: json.vector, ms: Date.now() - started };
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// 负向锚点:现在时/操作型句式。门用对比分 max(pos)-max(anchor),
// 挡开与回忆句在嵌入空间里天然接近的"这是什么/在哪/为什么"类提问。
const ANCHORS = [
  "what is this code doing?",
  "explain what this regex does",
  "how do I configure this option?",
  "where is git installed?",
  "fix the bug in the login page",
  "run the tests and report failures",
  "这段代码是干什么的？",
  "这个函数怎么写的？",
  "为什么构建失败了？",
  "把这个参数改成另一个",
  "这个选项在哪里设置？",
  "今天有什么安排",
];

const latencies = [];
async function embedAll(texts) {
  const out = [];
  for (const t of texts) {
    const { vector, ms } = await embed(t);
    latencies.push(ms);
    out.push(vector);
  }
  return out;
}

const exemplarVecs = await embedAll(EXEMPLARS);
const anchorVecs = await embedAll(ANCHORS);
const score = (v) => ({
  max: Math.max(...exemplarVecs.map((e) => cosine(v, e))),
  anchor: Math.max(...anchorVecs.map((a) => cosine(v, a))),
});
const posScores = [];
for (const [lang, q] of POSITIVES) {
  const v = (await embedAll([q]))[0];
  posScores.push({ lang, q, ...score(v) });
}
const negScores = [];
for (const [lang, q] of NEGATIVES) {
  const v = (await embedAll([q]))[0];
  negScores.push({ lang, q, ...score(v) });
}

const fmt = (s) =>
  `max=${s.max.toFixed(3)} anchor=${s.anchor.toFixed(3)} contrast=${(s.max - s.anchor).toFixed(3)}`;

const sorted = [...posScores].sort((a, b) => b.max - b.anchor - (a.max - a.anchor));
console.log("=== POSITIVES (recall questions), descending contrast ===");
for (const s of sorted) console.log(`${fmt(s)}  ${s.lang}  ${s.q}`);
const negSorted = [...negScores].sort((a, b) => b.max - b.anchor - (a.max - a.anchor));
console.log("=== NEGATIVES (distractors), descending contrast ===");
for (const s of negSorted) console.log(`${fmt(s)}  ${s.lang}  ${s.q}`);

const lats = latencies.sort((a, b) => a - b);
console.log(
  `=== embed latency: n=${lats.length} p50=${lats[Math.floor(lats.length / 2)]}ms p95=${lats[Math.floor(lats.length * 0.95)]}ms max=${lats[lats.length - 1]}ms`,
);

const contrast = (s) => s.max - s.anchor;
for (const t of [0.5, 0.55, 0.6, 0.65, 0.7]) {
  const tp = posScores.filter((s) => s.max >= t).length;
  const fp = negScores.filter((s) => s.max >= t).length;
  console.log(`pure-max ${t}: recall ${tp}/${POSITIVES.length}  FP ${fp}/${NEGATIVES.length}`);
}
for (const t of [0.55, 0.6, 0.65]) {
  const tp = posScores.filter((s) => s.max >= t && contrast(s) >= 0).length;
  const fp = negScores.filter((s) => s.max >= t && contrast(s) >= 0).length;
  console.log(`max>=${t} & contrast>=0: recall ${tp}/${POSITIVES.length}  FP ${fp}/${NEGATIVES.length}`);
}
for (const t of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3]) {
  const tp = posScores.filter((s) => contrast(s) >= t).length;
  const fp = negScores.filter((s) => contrast(s) >= t).length;
  console.log(`contrast ${t}: recall ${tp}/${POSITIVES.length}  FP ${fp}/${NEGATIVES.length}`);
}

