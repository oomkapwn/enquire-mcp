<div align="center">

<a href="https://github.com/oomkapwn/enquire-mcp"><img src="./assets/social-preview.png" alt="enquire-mcp — أكثر خوادم Obsidian MCP تطوّراً. ذاكرة طويلة الأمد لوكلاء الذكاء الاصطناعي." width="100%"></a>

# enquire-mcp

<sub>[English](./README.md) · [中文](./README.zh.md) · [Español](./README.es.md) · [हिन्दी](./README.hi.md) · **العربية** · [Русский](./README.ru.md) · [Português](./README.pt.md) · [Français](./README.fr.md) · [日本語](./README.ja.md)</sub>

### أكثر خوادم Obsidian MCP تطوّراً. ذاكرة طويلة الأمد لوكلاء الذكاء الاصطناعي.

**كُفّ عن إعادة شرح السياق لـ Claude وCursor وChatGPT وCodex وOpenClaw في كل جلسة. تصبح ملاحظاتك في Obsidian ذاكرةً مشتركةً قابلةً للبحث عبر كل وكيل متوافق مع MCP — معرفتك، وكل نموذج، وتظل ملكاً لك إلى الأبد.**

[![npm](https://img.shields.io/npm/v/@oomkapwn/enquire-mcp.svg?label=npm&color=cb3837)](https://www.npmjs.com/package/@oomkapwn/enquire-mcp)
[![stable](https://img.shields.io/badge/v3.10.x-stable-brightgreen.svg)](./STABILITY.md)
[![build provenance](https://img.shields.io/badge/build_provenance-SLSA_L2-blue.svg)](https://slsa.dev/spec/v1.0/levels#build-l2)
[![MCP](https://img.shields.io/badge/MCP-1.29-8A2BE2.svg)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)

**[⚡ التثبيت في 30 ثانية](#-البدء-السريع) · [🧠 حالات الاستخدام](#-حالات-الاستخدام) · [📊 قياسات الأداء](./docs/benchmarks.md) · [📖 مرجع API](https://oomkapwn.github.io/enquire-mcp/) · [💬 مقارنة البدائل](./docs/COMPARISON.md)**

**Claude Code — سطر واحد:**

```bash
claude mcp add obsidian -- npx -y @oomkapwn/enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
```

</div>

> 📌 هذا المستند هو الترجمة العربية لـ [README.md](./README.md) لتسهيل القراءة على المتحدثين بالعربية؛ عند أي اختلاف، **النسخة الإنجليزية هي المرجع** (تُحدَّث مع كل إصدار).

---

## المشكلة

<div dir="rtl" align="right">

كل جلسة ذكاء اصطناعي تبدأ من الصفر. تُعيد شرح مشروعك، وقراراتك التصميمية، ونتائج بحث الأسبوع الماضي مراراً وتكراراً. ميزات "الذاكرة" من المزوّدين ([Claude Memory](https://www.anthropic.com/news/memory-and-tool-use)، [ChatGPT Memory](https://openai.com/index/memory-and-new-controls-for-chatgpt/)، Cursor memory) تحبس معرفتك في سحابة مزوّد واحد — ثم تنساها من جديد حين تبدّل الأداة. **معرفتك تظل تبدأ من جديد.**

</div>

## الحل

<div dir="rtl" align="right">

تصبح مكتبة Obsidian (vault) لديك **ذاكرةً طويلة الأمد دائمة وقابلة للاستعلام** لأي وكيل متوافق مع MCP. تثبيت واحد — وتصير معرفتك متاحةً فوراً من Claude Code وClaude Desktop وCursor وChatGPT custom GPT وCodex وOpenClaw وكل عميل MCP آخر. ملفات markdown صِرفة **تملكها أنت**، مُفهرسة محلياً، يُبحث فيها بكامل حزمة استرجاع المعلومات (IR) الحديثة، وتُستدعى عبر كل جلسة وكل نموذج.

**راسخة في النص الأصلي، لا مستخلَصة.** أدوات ذاكرة المحادثات (mem0، Zep، Supermemory، Memobase) *تستخلص* الحقائق من سجلات دردشتك إلى مخزن منفصل لا يمكنك قراءته. أما enquire-mcp فهي العكس: إنها **راسخة في المعرفة التي كتبتها بالفعل** — ملاحظاتك `.md` نفسها، حرفياً، مع الاستشهادات — فالاستدعاء قابل للتدقيق، وقابل للتحرير في أي محرّر، وليس أبداً تلخيصاً ناقصاً لدردشة تتذكرها بالكاد. وبخلاف منصات ذاكرة **الأسطول (fleet-memory)** على جانب الخادم (مخازن سحابية متعددة المستأجرين تعيد صياغة حركة الوكلاء في قاعدة بيانات مشتركة)، فإن enquire **أحادية المستخدم ومحلية أولاً**: مكتبة واحدة تملكها بالكامل ويمكنك قراءتها وتحريرها وحذفها بنفسك، بصفر استدعاءات سحابية أثناء التشغيل (serve).

**راسخة — وواعية بالحداثة.** استدعاء حقيقةٍ ما هو نصف المشكلة؛ ومعرفة ما إن كانت لا تزال *صحيحة* هو النصف الآخر. أظهر [معيار Memora](https://arxiv.org/abs/2604.20006) (أبريل 2026) أن أنظمة الذاكرة تفشل بانتظام في إعادة استخدام الحقائق القديمة — فتستدعي ملاحظةً عمرها عام كأنها كُتبت اليوم. ولأن ذاكرة enquire *هي* ملفات markdown الحقيقية لديك، تحمل كل نتيجة بحث `age_days` (العمر بالأيام) وعلامة `stale` (قديمة) مشتقّة من وقت آخر تعديل حيّ للملاحظة، ويمكنك تفعيل الترتيب المرجَّح بالحداثة (`--recency-weight`) لتظهر الملاحظات الأحدث أولاً. معرفتك، واعية بالحداثة — لا كتلة بلا زمن.

> **ما الذي يميّز enquire-mcp**:
> 1. **محايدة تجاه المزوّدين.** ذاكرتك تعيش في ملفات `.md`. انتقل من Claude إلى Cursor — وتأتي ذاكرتك معك.
> 2. **استرجاع من الطراز الأول.** مزيج من BM25 + تضمينات متعددة اللغات + إعادة ترتيب بمُرمِّز متقاطع BGE، مدموجة عبر RRF، ومُوسَّعة بـ HNSW + تكميم int8. نفس حزمة IR التي قد تبنيها شركة بحث ناشئة — مفتوحة المصدر، في ثنائيّ واحد.
> 3. **صفر استدعاءات سحابية أثناء التشغيل.** النماذج مخزّنة محلياً (تنزيل لمرة واحدة من HuggingFace). محتوى مكتبتك لا يغادر جهازك أبداً. آمنة للعمل المعزول (air-gap) افتراضياً.
> 4. **استدعاء واعٍ بالحداثة.** تُبلّغ كل نتيجة عن عمر الملاحظة؛ وإعادة الترتيب الاختيارية بالحداثة تتيح للوكيل تفضيل المعرفة الحديثة ووسم الحقائق القديمة لإعادة التحقق — حدود "الوعي بالنسيان"، مبنيّة على `mtime` الذي تملكه ملفاتك أصلاً.

**46 أداة · 19 موجِّه MCP · 1385+ اختبار وحدة · 50+ لغة · إصدار مستقر v3.10.x · مُقيَّد بالـ semver · MIT · إثبات بناء npm (SLSA L2).**

</div>

---

## ⚡ البدء السريع

```bash
npm install -g @oomkapwn/enquire-mcp
enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
```

<div dir="rtl" align="right">

ضَعها في أي عميل MCP:

</div>

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "@oomkapwn/enquire-mcp", "serve", "--vault", "/path/to/vault"]
    }
  }
}
```

<div dir="rtl" align="right">

📂 إعدادات جاهزة للاستخدام في [`examples/`](./examples/) — **Claude Desktop** و**Cursor** و**ChatGPT custom GPT** (MCP بعيد عبر HTTP)، إضافةً إلى مجموعة استعلامات نموذجية لأداة التقييم.

**تريد القوة الكاملة للاسترجاع الهجين؟** انطلاقة بأمر واحد ودون أي إعداد يدوي:

</div>

```bash
enquire-mcp setup --vault <path>     # downloads model, builds FTS5 + embed-db
enquire-mcp serve --vault <path> --persistent-index --enable-reranker --use-hnsw
enquire-mcp doctor --vault <path>    # color-coded ✓/⚠/✗ health check
```

---

## 🧠 حالات الاستخدام

<div dir="rtl" align="right">

**1 — ذاكرة طويلة الأمد لوكلاء الذكاء الاصطناعي.** ضَع مكتبة Obsidian لديك في أي وكيل متوافق مع MCP (Claude Code، Claude Desktop، Cursor، ChatGPT، Codex، OpenClaw). يحصل الوكيل عندها على استدعاء دلاليّ مُتين لكل ملاحظة اجتماع ومُدخل يوميات وسجل بحث ووثيقة قرار كتبتها يوماً — عبر الجلسات والنماذج والمزوّدين. وبخلاف `Claude Memory` أو `ChatGPT Memory`، معرفتك ليست محبوسة في سحابة مزوّد واحد؛ بل تعيش في markdown صِرف تملكه وتهاجر به بحرّية.

**2 — قاعدة معرفة شخصية / دماغ ثانٍ.** يُظهر الاسترجاع الهجين الملاحظة الصحيحة لـ*أي* صياغة، في أيٍّ من 50+ لغة. اسأل بالإنجليزية عن مُدخل يوميات بالروسية من قبل عامين، واحصل على النتيجة الصحيحة. تُعيد إضافة Wikilink graph-boost ترتيب الملاحظات الواقعة في قلب رسم معرفتك. ويُظهر GraphRAG-light المجتمعات الموضوعية — لتكتشف روابط نسيت أنك صنعتها. وتندمج ملفات PDF في البحث مع استشهادات `[page: N]`، فتصير الأوراق البحثية ونصوص الاجتماعات ذاكرةً من الدرجة الأولى.

**3 — RAG وكيليّ / هندسة سياق.** يكشف `obsidian_search` درجات كل إشارة على حدة، فيرى الوكيل *لماذا* احتلّت كل نتيجة ترتيبها. يُعيد HyDE صياغة الاستعلامات الغامضة إلى إجابات افتراضية ثرية قبل الاسترجاع. ويعالج تفكيك الأسئلة الفرعية الأسئلةَ متعددة القفزات بتقسيمها إلى استعلامات فرعية مستقلة ثم دمج النتائج. وتتيح لك أداة التقييم المدمجة (NDCG / Recall / MRR) قياس جودة الاسترجاع على استعلاماتك أنت، بدل الوثوق بمعايير المزوّدين.

</div>

---

## 🚫 متى لا تكون enquire-mcp الأداة المناسبة

<div dir="rtl" align="right">

أهداف غير مقصودة بصراحة — اختر شيئاً آخر حين:

- **تريد بحثاً حرفياً / بالتعبيرات النمطية.** `ripgrep` / `grep` أسرع وأدق في "ابحث عن هذا الرمز بالضبط". تتألق enquire في الاستدعاء *المفاهيمي* — المرادفات، وعبر اللغات، و"ماذا قلت عن X". استخدم كليهما: `rg` للحرفي، وenquire للمعنى.
- **معرفتك تعيش في سجلات الدردشة، لا في الملاحظات.** enquire *راسخة* في markdown الذي كتبته بنفسك. أدوات ذاكرة المحادثات (mem0، Zep، Supermemory) التي *تستخلص* الحقائق من نصوص الدردشة إلى مخزن منفصل هي فئة مختلفة — راجع [المقارنة](./docs/COMPARISON.md).
- **تحتاج بحثاً متعدد المستخدمين / مُستضافاً / مُزامَناً.** enquire محلية أولاً وأحادية المكتبة بحكم التصميم — لا فهرس متعدد المستأجرين على جانب الخادم.
- **مصادرك ليست Markdown أو PDF.** صيغ `.md` / `.canvas` / `.base` / `.pdf` من الدرجة الأولى؛ أما الصيغ الأخرى فتحتاج تحويلاً أولاً.
- **تريد واجهة رسومية أو إضافة Obsidian داخل التطبيق.** enquire خادم MCP / CLI بلا واجهة — إنها *تُكمّل* Obsidian ولا تحلّ محلّه. (Smart Connections هو خيار الإضافة داخل التطبيق.)
- **تحتاج بحثاً دون المليمتر-ثانية عبر ملايين الملاحظات.** يمنح HNSW سرعة top-K دون 10ms على نطاق واسع، لكن enquire موجَّهة للمكتبات الشخصية / الفِرَقية، لا لمجموعات النصوص بحجم الويب.

</div>

---

## 🏆 لماذا هي الأفضل

<div dir="rtl" align="right">

**ست ميزات لا يملكها أي Obsidian-MCP آخر بتاتاً** (GraphRAG-light، تنفيذ `.base` مستقل، HyDE، تكميم int8، late-chunking، أداة تقييم مدمجة)، **إضافةً إلى حزمة IR الحديثة بأكملها** (BM25 + تضمينات + إعادة ترتيب بمُرمِّز متقاطع + HNSW)، بينما لا يقدّم المنافسون منها سوى واحدة أو اثنتين على الأكثر. مقارنة جنباً إلى جنب:

</div>

| القدرة | enquire-mcp | Smart Connections | Obsidian-MCP أخرى |
|---|:---:|:---:|:---:|
| الاسترجاع الهجين (BM25 + TF-IDF + تضمينات، مدموج بـ RRF) | ✅ | ❌ | ❌ |
| **إعادة الترتيب بمُرمِّز متقاطع** (BGE، ‎+15.5 NDCG@10 مقاسة) | ✅ | ❌ | ❌ |
| **فهرس متجهات HNSW** (top-K دون 10ms، مُستديم) | ✅ | ❌ | ❌ |
| **تكميم المتجهات int8** (حجم embed-db أصغر بنحو الرُّبع) | ✅ | ❌ | ❌ |
| **بحث دلاليّ متعدد اللغات** (50+ لغة، على الجهاز) | ✅ | 💰 مدفوع | ❌ |
| **دمج ملفات PDF في البحث الهجين** (استشهادات `[page: N]` + OCR) | ✅ | ❌ | ❌ |
| **إشارة استرجاع Wikilink graph-boost** | ✅ | ❌ | ❌ |
| **أداة تقييم جودة الاسترجاع مدمجة** (NDCG، Recall، MRR) | ✅ | ❌ | ❌ |
| **MCP بعيد** (HTTP + bearer auth + جلسات ذات حالة) | ✅ | ❌ | جزئي |
| **MCP أصيل** (Claude · Cursor · ChatGPT · Codex · OpenClaw · أي عميل) | ✅ | ❌ Obsidian فقط | متفاوت |
| **مرشّح خصوصية** مُتحقَّق منه عند كل مسار بحث + كتابة | ✅ | غير منطبق | ❌ |
| **46 أداة إنتاجية** (34 أداة قراءة دائمة + 4 اختيارية + 7 كتابات محكومة + 1 تغذية راجعة) | ✅ | غير منطبق | متفاوت |
| **GraphRAG-light** (كشف مجتمعات بمعامل Louvain) | ✅ **حصرياً هنا** | ❌ | ❌ |
| **تنفيذ استعلام `.base` مستقل** (يعمل دون تشغيل Obsidian) | ✅ **حصرياً هنا** | ❌ | ❌ |
| **استرجاع HyDE** + تفكيك الأسئلة الفرعية | ✅ **حصرياً هنا** | ❌ | ❌ |
| **إثبات بناء موقَّع** (npm + Sigstore، SLSA L2) | ✅ | غير منطبق | ❌ |
| تشغيل مستقل (لا حاجة لإضافة Obsidian) | ✅ | ❌ يتطلب Obsidian | متفاوت |
| الترخيص | MIT، مجاني | احتكاري، مدفوع | متفاوت |

<sub>تستند المقارنة إلى القدرات العلنية لكل مشروع حتى الإصدار المستقر v3.8.x. ‏Smart Connections إضافة Obsidian مدفوعة (لا خادم MCP). ويُقصد بـ"Obsidian-MCP أخرى" خوادم Obsidian-MCP مفتوحة المصدر العلنية على GitHub وقت الكتابة. وتُنشر قياسات الاسترجاع الشاملة لـ enquire-mcp في <a href="./docs/benchmarks.md"><code>docs/benchmarks.md</code></a> — فارق `rerank-bge` المقاس هو ‎+24.7 MRR / +15.5 NDCG@10 مقارنةً بالهجين الصِّرف على استئصال من 60 استعلاماً.</sub>

<div dir="rtl" align="right">

> ادّعاء استراتيجي: enquire-mcp هي الخلفية مفتوحة المصدر لـ[ويكيات LLM بأسلوب Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) فوق مكتبة Obsidian القائمة لديك. معرفة تتراكم، قابلة للتتبّع إلى مصادرها.

</div>

---

## 🏗️ كيف يعمل الاسترجاع

<div dir="rtl" align="right">

يكتشف `obsidian_search` الإشارات المتاحة تلقائياً ويتراجع بلُطف: BM25 / FTS5 + TF-IDF + تضمينات (HNSW) ← دمج RRF (k=60) ← Wikilink graph-boost (α × الدرجة الداخلة، PageRank مُشخصَن بخطوة واحدة) ← إعادة ترتيب بمُرمِّز متقاطع BGE ← نتائج مرتّبة مع قابلية رصد `per_signal`. تُعيد كل نتيجة `per_signal: { bm25, tfidf, embeddings }`، فترى *لماذا* احتلّت ترتيبها.

طبقات يمكن تفعيلها حسب الحاجة:

</div>

| الطبقة | طريقة التفعيل | ما تحصل عليه |
|---|---|---|
| **1** | `serve --vault <path>` | TF-IDF cosine (بلا إعداد، فوري) |
| **2** | + `--persistent-index` | + BM25 / FTS5 (top-10 دون 100ms) |
| **3** | + `setup` (تنزيل نموذج + بناء embed-db) | + تضمينات ML متعددة اللغات |
| **4** | + `--enable-reranker` | + مُرمِّز متقاطع BGE (‎+15.5 NDCG@10 مقاسة) |
| **5** | + `--use-hnsw` | + top-K دون 10ms على نطاق ملايين الـ chunks |
| **6** | + `--include-pdfs` | + دمج ملفات PDF في كل ما سبق |
| **7** | `serve-http --bearer-token …` | + MCP بعيد (ويب Claude.ai، ChatGPT، Cursor HTTP، الجوال) |

---

## 🛠️ جميع الأدوات الـ 46

<div dir="rtl" align="right">

46 أداة إجمالاً: 34 قراءة دائمة (بما في ذلك المدخل الجامع `obsidian_search`) + 4 اختيارية + 7 كتابات محكومة + 1 تغذية راجعة بحلقة مغلقة. المرجع الكامل في **[docs/api.md](./docs/api.md)**، ويشمل: البحث والاسترجاع، وWikilink والرسم، وFrontmatter وDataview، وCanvas، وObsidian Bases، وPDF + OCR، وكشف المجتمعات، وأدوات الكتابة (تتطلب `--enable-write`) وغيرها.

</div>

---

## 🛡️ الثقة

| الجانب | السياسة |
|---|---|
| **الافتراضي** | للقراءة فقط — تتطلب أدوات الكتابة السبع `--enable-write` |
| **أقل الامتيازات** | يُتيح `--disabled-tools` / `--enabled-tools` كشف أقل سطح ممكن (مثلاً وكيل بحث للقراءة فقط يحصل على `obsidian_search` + `obsidian_read_note` فحسب) |
| **سلامة المسار** | فحص realpath عند كل قراءة + كتابة؛ ورفض الروابط الرمزية الخارجة عن المكتبة |
| **مرشّح الخصوصية** | مُتحقَّق منه عند مسارات FTS5 + embed-db + موارد الـ chunk؛ يفشل مغلقاً عند قوائم سماح/حظر فارغة |
| **نقل HTTP** | مصادقة Bearer (SHA-256 بزمن ثابت + `timingSafeEqual`)، تحديد معدّل لكل token، وCORS صارم |
| **البناء والإصدار** | نشر على npm + GitHub Release لكل tag · semver · **إثبات بناء موقَّع** (npm + Sigstore، SLSA L2) |

<div dir="rtl" align="right">

نموذج الأمان الكامل في **[SECURITY.md](./SECURITY.md)** · حدود الاستقرار في **[STABILITY.md](./STABILITY.md)** · للإبلاغ عن الثغرات: `oomkapwn@gmail.com`.

</div>

---

## ❓ أسئلة شائعة

<div dir="rtl" align="right">

**هل يلزم تثبيت Obsidian؟** لا. يقرأ `.md` + `.canvas` + `.pdf` مباشرةً. يعمل على أي مكتبة بصيغة Obsidian.

**هل سيكتب في مكتبتي؟** لا، إلا إذا مرّرت `--enable-write`. أدوات الكتابة السبع كلها محكومة؛ والعمليات الإتلافية تدعم `dry_run`.

**هل تُرسَل بياناتي إلى أي مكان؟** فقط عند `enquire-mcp install-model` (تنزيل أوزان ONNX من HuggingFace لمرة واحدة). وضع التشغيل (serve) لا يجري أبداً أي اتصال HTTP خارجي. التضمينات وإعادة الترتيب تعمل محلياً على وحدة المعالجة المركزية.

**ما الأداء؟** بناء FTS5 على البارد: نحو 5s/1k ملاحظة، ونحو 30s/50k. استعلام BM25: دائماً <100ms. **HNSW top-10: دون 10ms على أي نطاق.** بدء التشغيل على البارد مع استدامة HNSW: نحو 50ms.

**أي اللغات؟** افتراضياً `paraphrase-multilingual-MiniLM-L12-v2` (50+ لغة)، ومُرمِّز متقاطع متعدد اللغات. تجزئة CJK / التايلندية / الخميرية عبر `Intl.Segmenter`.

**هل يمكن تشغيلها عن بُعد؟** نعم — يكشف `serve-http` الخادم نفسه عبر [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http). ضَع أمامه Tailscale Funnel أو Cloudflare Tunnel من أجل HTTPS. يعمل مع ويب claude.ai، وChatGPT custom GPT، ووضع Cursor HTTP، وعملاء MCP على الجوال. راجع **[docs/http-transport.md](./docs/http-transport.md)**.

</div>

---

## 🚀 الإصدارات

<div dir="rtl" align="right">

القناة: `npm install @oomkapwn/enquire-mcp` ← أحدث إصدار مستقر (`@latest` = v3.10.x). الإصدار التجريبي: `npm install @oomkapwn/enquire-mcp@rc` (أحدث مرشّح إصدار). سجل التغييرات الكامل في **[CHANGELOG.md](./CHANGELOG.md)** · خارطة الطريق في **[ROADMAP.md](https://github.com/oomkapwn/enquire-mcp/blob/main/ROADMAP.md)**.

</div>

## 🤝 المساهمة

<div dir="rtl" align="right">

البلاغات (issues) وطلبات الدمج (PRs) مرحَّب بها. سير عمل التطوير في **[CONTRIBUTING.md](https://github.com/oomkapwn/enquire-mcp/blob/main/CONTRIBUTING.md)**؛ ودليل المستودع الموجَّه للوكلاء في **[AGENTS.md](https://github.com/oomkapwn/enquire-mcp/blob/main/AGENTS.md)**.

</div>

## 📜 الترخيص

<div dir="rtl" align="right">

[MIT](./LICENSE) © Alex (@OomkaBear)

</div>
