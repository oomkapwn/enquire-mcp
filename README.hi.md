<div align="center">

<a href="https://github.com/oomkapwn/enquire-mcp"><img src="./assets/social-preview.png" alt="enquire-mcp — सबसे उन्नत Obsidian MCP। AI एजेंट्स के लिए दीर्घकालिक स्मृति।" width="100%"></a>

# enquire-mcp

<sub>[English](./README.md) · [中文](./README.zh.md) · [Español](./README.es.md) · **हिन्दी** · [العربية](./README.ar.md) · [Русский](./README.ru.md) · [Português](./README.pt.md) · [Français](./README.fr.md) · [日本語](./README.ja.md)</sub>

### सबसे उन्नत Obsidian MCP। AI एजेंट्स के लिए बनी दीर्घकालिक स्मृति।

**हर सत्र में Claude, Cursor, ChatGPT, Codex, OpenClaw को संदर्भ दोबारा समझाना बंद करें। आपके Obsidian नोट्स हर MCP-संगत एजेंट के बीच साझा, खोजने-योग्य स्मृति बन जाते हैं — आपका ज्ञान, हर मॉडल, हमेशा आपका अपना।**

[![npm](https://img.shields.io/npm/v/@oomkapwn/enquire-mcp.svg?label=npm&color=cb3837)](https://www.npmjs.com/package/@oomkapwn/enquire-mcp)
[![stable](https://img.shields.io/badge/v3.10.x-stable-brightgreen.svg)](./STABILITY.md)
[![build provenance](https://img.shields.io/badge/build_provenance-SLSA_L2-blue.svg)](https://slsa.dev/spec/v1.0/levels#build-l2)
[![MCP](https://img.shields.io/badge/MCP-1.29-8A2BE2.svg)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)

**[⚡ 30-सेकंड इंस्टॉल](#-त्वरित-शुरुआत) · [🧠 उपयोग के मामले](#-उपयोग-के-मामले) · [📊 बेंचमार्क](./docs/benchmarks.md) · [📖 API संदर्भ](https://oomkapwn.github.io/enquire-mcp/) · [💬 विकल्पों से तुलना](./docs/COMPARISON.md)**

**Claude Code — एक पंक्ति:**

```bash
claude mcp add obsidian -- npx -y @oomkapwn/enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
```

</div>

> 📌 यह दस्तावेज़ [README.md](./README.md) का हिन्दी अनुवाद है, जो हिन्दी पाठकों की सुविधा के लिए है; किसी भी विसंगति की स्थिति में **अंग्रेज़ी संस्करण ही प्रामाणिक है** (अंग्रेज़ी संस्करण हर रिलीज़ के साथ अपडेट होता है)।

---

## समस्या

हर AI सत्र शून्य से शुरू होता है। आप अपनी परियोजना, अपने डिज़ाइन निर्णय, पिछले हफ़्ते के शोध के निष्कर्ष बार-बार समझाते हैं। विक्रेताओं की "स्मृति" सुविधाएँ ([Claude Memory](https://www.anthropic.com/news/memory-and-tool-use), [ChatGPT Memory](https://openai.com/index/memory-and-new-controls-for-chatgpt/), Cursor memory) आपके ज्ञान को किसी एक प्रदाता के क्लाउड में बंद कर देती हैं — और जब आप टूल बदलते हैं तो उसे फिर भूल जाती हैं। **आपका ज्ञान बार-बार नए सिरे से शुरू होता रहता है।**

## समाधान

आपका Obsidian vault किसी भी MCP-संगत एजेंट के लिए **स्थायी, क्वेरी-योग्य दीर्घकालिक स्मृति** बन जाता है। एक बार इंस्टॉल करें — आपका ज्ञान तुरंत Claude Code, Claude Desktop, Cursor, ChatGPT कस्टम GPT, Codex, OpenClaw, और हर दूसरे MCP क्लाइंट से सुलभ हो जाता है। सादे markdown फ़ाइलें **जो आपकी अपनी हैं**, स्थानीय रूप से अनुक्रमित, पूरे आधुनिक IR स्टैक के साथ खोजी जाती हैं, और हर सत्र व हर मॉडल में याद की जाती हैं।

**मूल पर आधारित, निकाला हुआ नहीं।** बातचीत-स्मृति टूल (mem0, Zep, Supermemory, Memobase) आपके चैट लॉग से तथ्य *निकालकर* एक अलग स्टोर में रखते हैं जिसे आप पढ़ नहीं सकते। enquire-mcp इसका उल्टा है: यह **उस ज्ञान पर आधारित है जो आपने पहले से लिखा है** — आपके अपने `.md` नोट्स, शब्दशः, उद्धरणों सहित — इसलिए recall ऑडिट-योग्य है, किसी भी एडिटर में संपादन-योग्य है, और कभी भी किसी आधी-याद बातचीत का हानिपूर्ण सारांश नहीं होता। और सर्वर-साइड ***fleet*-memory** प्लेटफ़ॉर्म्स (मल्टी-टेनेंट क्लाउड स्टोर जो एजेंट ट्रैफ़िक को एक साझा डेटाबेस में पैराफ़्रेज़ कर देते हैं) के विपरीत, enquire **एकल-उपयोगकर्ता और स्थानीय-प्रथम** है: एक ऐसा vault जो पूरी तरह आपका है और जिसे आप स्वयं पढ़, संपादित और हटा सकते हैं, serve के दौरान शून्य क्लाउड कॉल के साथ।

**मूल पर आधारित — और ताज़गी के प्रति सजग।** किसी तथ्य को याद करना आधी समस्या है; यह जानना कि वह अब भी *सही* है या नहीं, बाकी आधी है। [Memora बेंचमार्क](https://arxiv.org/abs/2604.20006) (अप्रैल 2026) ने दिखाया कि स्मृति प्रणालियाँ व्यवस्थित रूप से बासी-तथ्य पुनरुपयोग में विफल रहती हैं — एक साल पुराने नोट को ऐसे याद करती हैं मानो वह आज ही लिखा गया हो। चूँकि enquire की स्मृति *ही* आपकी असली markdown फ़ाइलें हैं, इसलिए हर खोज-परिणाम के साथ नोट के लाइव अंतिम-संशोधन समय से व्युत्पन्न `age_days` + एक `stale` फ़्लैग आता है, और आप recency-भारित रैंकिंग (`--recency-weight`) चुन सकते हैं ताकि ताज़ा नोट्स पहले सामने आएँ। आपका ज्ञान, ताज़गी के प्रति सजग — न कि एक कालातीत ढेर।

> **enquire-mcp को अलग क्या बनाता है**:
> 1. **विक्रेता-तटस्थ।** आपकी स्मृति `.md` फ़ाइलों में रहती है। Claude से Cursor पर जाएँ — आपकी स्मृति आपके साथ आती है।
> 2. **श्रेणी में सर्वश्रेष्ठ retrieval।** हाइब्रिड BM25 + बहुभाषी embeddings + BGE cross-encoder reranker, RRF के माध्यम से fused, HNSW + int8 quantization के साथ स्केल्ड। वही IR स्टैक जो एक सर्च स्टार्टअप बनाता — ओपन-सोर्स, एक ही बाइनरी में।
> 3. **serve के दौरान शून्य क्लाउड कॉल।** मॉडल स्थानीय रूप से कैश्ड (HuggingFace से एक-बार डाउनलोड)। आपके vault की सामग्री कभी आपकी मशीन नहीं छोड़ती। डिफ़ॉल्ट रूप से एयर-गैप-सुरक्षित।
> 4. **ताज़गी-सजग recall।** हर परिणाम बताता है कि नोट कितना पुराना है; वैकल्पिक recency re-ranking एजेंट को ताज़ा ज्ञान को प्राथमिकता देने और बासी तथ्यों को पुनः-सत्यापन हेतु चिह्नित करने देता है — भूलने-के-प्रति-सजग सीमांत, जो आपकी फ़ाइलों में पहले से मौजूद `mtime` पर बना है।

**46 टूल · 19 MCP प्रॉम्प्ट · 1425+ यूनिट टेस्ट · 50+ भाषाएँ · v3.10.x स्थिर · semver-बाध्य · MIT · npm बिल्ड प्रोवेनेंस (SLSA L2)।**

---

## ⚡ त्वरित शुरुआत

```bash
npm install -g @oomkapwn/enquire-mcp
enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
```

किसी भी MCP क्लाइंट में जोड़ें:

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

📂 तैयार कॉन्फ़िग [`examples/`](./examples/) में — **Claude Desktop**, **Cursor**, **ChatGPT कस्टम GPT** (HTTP पर रिमोट MCP), साथ ही eval harness के लिए एक नमूना क्वेरी सेट।

**पूरी हाइब्रिड शक्ति चाहिए?** एक कमांड, ज़ीरो-टच ऑनबोर्डिंग:

```bash
enquire-mcp setup --vault <path>     # मॉडल डाउनलोड करता है, FTS5 + embed-db बनाता है
enquire-mcp serve --vault <path> --persistent-index --enable-reranker --use-hnsw
enquire-mcp doctor --vault <path>    # रंग-कोडित ✓/⚠/✗ स्वास्थ्य जाँच
```

---

## 🧠 उपयोग के मामले

**1 — AI एजेंट्स के लिए दीर्घकालिक स्मृति।** अपने Obsidian vault को किसी भी MCP-संगत एजेंट (Claude Code, Claude Desktop, Cursor, ChatGPT, Codex, OpenClaw) में जोड़ें। एजेंट के पास अब आपके लिखे हर मीटिंग नोट, जर्नल प्रविष्टि, शोध लॉग और निर्णय दस्तावेज़ पर टिकाऊ, सिमेंटिक recall होता है — सत्रों, मॉडलों और प्रदाताओं के पार। `Claude Memory` या `ChatGPT Memory` के विपरीत, आपका ज्ञान किसी एक विक्रेता के क्लाउड में बंद नहीं होता; यह सादे markdown में रहता है जो आपका अपना है और जिसे आप स्वतंत्र रूप से माइग्रेट कर सकते हैं।

**2 — व्यक्तिगत ज्ञान-आधार / दूसरा दिमाग।** हाइब्रिड retrieval *किसी भी* शब्द-रचना के लिए, 50+ भाषाओं में से किसी में भी, सही नोट सामने लाता है। दो साल पुरानी रूसी-भाषा जर्नल प्रविष्टि के बारे में अंग्रेज़ी में पूछें, सही हिट पाएँ। Wikilink ग्राफ़-बूस्ट उन नोट्स को री-रैंक करता है जो आपके ज्ञान-ग्राफ़ के केंद्र में बैठे हैं। GraphRAG-light विषयगत समुदायों को सामने लाता है — उन संबंधों की खोज करें जिन्हें बनाना आप भूल गए थे। PDF `[page: N]` उद्धरणों के साथ खोज में घुल-मिल जाते हैं ताकि शोध-पत्र और मीटिंग ट्रांसक्रिप्ट प्रथम-श्रेणी स्मृति बन जाएँ।

**3 — एजेंटिक RAG / संदर्भ इंजीनियरिंग।** `obsidian_search` प्रति-संकेत स्कोर उजागर करता है ताकि एजेंट देख सके कि हर हिट *क्यों* रैंक हुई। HyDE retrieval से पहले अस्पष्ट क्वेरियों को समृद्ध काल्पनिक उत्तरों में पुनः-लिखता है। उप-प्रश्न विघटन बहु-हॉप प्रश्नों को स्वतंत्र उप-क्वेरियों में तोड़कर, परिणाम fuse करके संभालता है। अंतर्निहित eval harness (NDCG / Recall / MRR) आपको विक्रेता बेंचमार्क पर भरोसा करने के बजाय अपनी क्वेरियों पर retrieval गुणवत्ता मापने देता है।

---

## 🚫 कब enquire-mcp सही टूल *नहीं* है

ईमानदार ग़ैर-लक्ष्य — निम्नलिखित स्थितियों में कुछ और चुनें:

- **आपको शाब्दिक स्ट्रिंग / regex खोज चाहिए।** "इस सटीक टोकन को ढूँढो" के लिए `ripgrep` / `grep` तेज़ और सटीक है। enquire *वैचारिक* recall में चमकता है — पर्यायवाची, क्रॉस-लैंग्वेज, "मैंने X के बारे में क्या कहा था"। दोनों का उपयोग करें: शाब्दिक के लिए `rg`, अर्थ के लिए enquire।
- **आपका ज्ञान चैट लॉग में है, नोट्स में नहीं।** enquire उस markdown पर *आधारित* है जो आपने स्वयं लिखी। चैट ट्रांसक्रिप्ट से तथ्य *निकालकर* अलग स्टोर में रखने वाले बातचीत-स्मृति टूल (mem0, Zep, Supermemory) एक अलग श्रेणी हैं — [तुलना](./docs/COMPARISON.md) देखें।
- **आपको मल्टी-यूज़र / होस्टेड / सिंक्ड खोज चाहिए।** enquire डिज़ाइन से स्थानीय-प्रथम और एकल-vault है — कोई सर्वर-साइड मल्टी-टेनेंट इंडेक्स नहीं।
- **आपके स्रोत Markdown या PDF नहीं हैं।** `.md` / `.canvas` / `.base` / `.pdf` प्रथम-श्रेणी हैं; अन्य प्रारूपों को पहले रूपांतरित करना होगा।
- **आपको GUI या इन-ऐप Obsidian प्लगइन चाहिए।** enquire एक हेडलेस MCP सर्वर / CLI है — यह Obsidian का *पूरक* है, स्वयं Obsidian नहीं। (Smart Connections इन-ऐप प्लगइन विकल्प है।)
- **आपको लाखों नोट्स पर सब-मिलीसेकंड खोज चाहिए।** HNSW बड़े पैमाने पर sub-10ms top-K देता है, पर enquire व्यक्तिगत / टीम vaults को लक्षित करता है, वेब-पैमाने के कोरपोरा को नहीं।

---

## 🏆 यह सर्वश्रेष्ठ क्यों है

**छह क्षमताएँ जो किसी अन्य Obsidian-MCP में बिल्कुल नहीं हैं** (GraphRAG-light, स्वतंत्र `.base` निष्पादन, HyDE, int8 quantization, late-chunking, अंतर्निहित eval harness), **साथ ही पूरा आधुनिक IR स्टैक** (BM25 + ML embeddings + cross-encoder reranking + HNSW), जबकि प्रतिस्पर्धी अधिक-से-अधिक एक-दो ही देते हैं। साथ-साथ तुलना:

| क्षमता | enquire-mcp | Smart Connections | अन्य Obsidian-MCP |
|---|:---:|:---:|:---:|
| हाइब्रिड retrieval (BM25 + TF-IDF + ML embeddings, RRF-fused) | ✅ | ❌ | ❌ |
| **Cross-encoder reranking** (BGE, मापा गया +15.5 NDCG@10) | ✅ | ❌ | ❌ |
| **HNSW वेक्टर इंडेक्स** (sub-10ms top-K, persisted) | ✅ | ❌ | ❌ |
| **int8 वेक्टर quantization** (~4× छोटी embed-db) | ✅ | ❌ | ❌ |
| **बहुभाषी सिमेंटिक खोज** (50+ भाषाएँ, ऑन-डिवाइस) | ✅ | 💰 भुगतान | ❌ |
| **हाइब्रिड खोज में घुले PDF** (`[page: N]` उद्धरण + OCR) | ✅ | ❌ | ❌ |
| **Wikilink ग्राफ़-बूस्ट** retrieval संकेत | ✅ | ❌ | ❌ |
| **अंतर्निहित retrieval-गुणवत्ता eval harness** (NDCG, Recall, MRR) | ✅ | ❌ | ❌ |
| **रिमोट MCP** (HTTP + bearer auth + stateful sessions) | ✅ | ❌ | आंशिक |
| **MCP-नेटिव** (Claude · Cursor · ChatGPT · Codex · OpenClaw · कोई भी क्लाइंट) | ✅ | ❌ केवल Obsidian | भिन्न |
| **प्राइवेसी फ़िल्टर** हर खोज + लेखन पथ पर सत्यापित | ✅ | लागू नहीं | ❌ |
| **46 प्रोडक्शन टूल** (34 हमेशा-चालू read + 4 opt-in + 7 gated writes + 1 फ़ीडबैक) | ✅ | लागू नहीं | भिन्न |
| **GraphRAG-light** (Louvain modularity समुदाय-पहचान) | ✅ **केवल यहीं** | ❌ | ❌ |
| **स्वतंत्र `.base` क्वेरी निष्पादन** (Obsidian चले बिना काम करता है) | ✅ **केवल यहीं** | ❌ | ❌ |
| **HyDE retrieval** + उप-प्रश्न विघटन | ✅ **केवल यहीं** | ❌ | ❌ |
| **साइन्ड बिल्ड प्रोवेनेंस** (npm + Sigstore, SLSA L2) | ✅ | लागू नहीं | ❌ |
| स्वतंत्र (कोई Obsidian प्लगइन ज़रूरी नहीं) | ✅ | ❌ Obsidian ज़रूरी | भिन्न |
| लाइसेंस | MIT, मुफ़्त | प्रोप्राइटरी, भुगतान | भिन्न |

<sub>तुलना प्रत्येक परियोजना की v3.8.x स्थिर तक की सार्वजनिक क्षमताओं पर आधारित है। Smart Connections एक भुगतान वाला Obsidian प्लगइन है (MCP सर्वर नहीं)। "अन्य Obsidian-MCP" से तात्पर्य लेखन के समय GitHub पर मौजूद सार्वजनिक ओपन-सोर्स Obsidian-MCP सर्वरों से है। enquire-mcp के एंड-टू-एंड retrieval बेंचमार्क <a href="./docs/benchmarks.md"><code>docs/benchmarks.md</code></a> में प्रकाशित हैं — मापा गया `rerank-bge` अंतर 60-क्वेरी ablation पर सादे हाइब्रिड की तुलना में +24.7 MRR / +15.5 NDCG@10 है।</sub>

> रणनीतिक दावा: enquire-mcp आपके मौजूदा Obsidian vault के ऊपर [Karpathy-शैली LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) के लिए ओपन-सोर्स बैकएंड है। ऐसा ज्ञान जो चक्रवृद्धि होता है, स्रोतों तक खोज-योग्य।

---

## 🏗️ Retrieval कैसे काम करता है

`obsidian_search` उपलब्ध संकेतों का स्वचालित पता लगाता है और सुंदरता से degrade होता है: BM25 / FTS5 + TF-IDF + ML embeddings (HNSW) → RRF fusion (k=60) → Wikilink ग्राफ़-बूस्ट (α × in-degree, सिंगल-स्टेप personalised PageRank) → BGE cross-encoder reranker → `per_signal` observability वाले रैंक्ड हिट्स। हर हिट `per_signal: { bm25, tfidf, embeddings }` लौटाता है ताकि आप देख सकें कि वह *क्यों* रैंक हुई।

स्तरों में सक्षम करें, आवश्यकतानुसार लें:

| स्तर | सेटअप | आपको क्या मिलता है |
|---|---|---|
| **1** | `serve --vault <path>` | TF-IDF cosine (ज़ीरो सेटअप, तत्काल) |
| **2** | + `--persistent-index` | + BM25 / FTS5 (sub-100ms top-10) |
| **3** | + `setup` (मॉडल डाउनलोड + embed-db बनाता है) | + बहुभाषी ML embeddings |
| **4** | + `--enable-reranker` | + BGE cross-encoder (मापा गया +15.5 NDCG@10) |
| **5** | + `--use-hnsw` | + मिलियन-chunk पैमाने पर sub-10ms top-K |
| **6** | + `--include-pdfs` | + उपरोक्त सभी में घुले PDF |
| **7** | `serve-http --bearer-token …` | + रिमोट MCP (Claude.ai वेब, ChatGPT, Cursor HTTP, मोबाइल) |

---

## 🛠️ सभी 46 टूल

कुल 46 टूल: 34 हमेशा-चालू read (अम्ब्रेला `obsidian_search` सहित) + 4 opt-in + 7 gated writes + 1 क्लोज़्ड-लूप फ़ीडबैक। पूर्ण संदर्भ **[docs/api.md](./docs/api.md)** में, जो शामिल करता है: खोज व retrieval, Wikilink व ग्राफ़, Frontmatter व Dataview, Canvas, Obsidian Bases, PDF + OCR, समुदाय-पहचान, लेखन टूल (`--enable-write` ज़रूरी) आदि।

इसके अलावा 3 MCP resources और सामान्य vault वर्कफ़्लो के लिए 19 **MCP प्रॉम्प्ट**।

---

## 🛡️ भरोसा

| पहलू | रुख |
|---|---|
| **डिफ़ॉल्ट** | केवल-पठन — 7 लेखन टूल के लिए `--enable-write` ज़रूरी |
| **न्यूनतम विशेषाधिकार** | `--disabled-tools` / `--enabled-tools` एक न्यूनतम सतह उजागर करते हैं (जैसे केवल-पठन शोध एजेंट को सिर्फ़ `obsidian_search` + `obsidian_read_note` मिलता है) |
| **पथ सुरक्षा** | हर read+write पर realpath जाँच; vault से बाहर जाने वाले symlinks अस्वीकृत |
| **प्राइवेसी फ़िल्टर** | FTS5 + embed-db + chunk resource पथों पर सत्यापित; खाली allow-/deny-list पर fail-closed |
| **HTTP ट्रांसपोर्ट** | Bearer auth (constant-time SHA-256 + `timingSafeEqual`), प्रति-token rate-limit, सख़्त CORS |
| **रिलीज़** | प्रति tag npm + GitHub release · semver · **साइन्ड बिल्ड प्रोवेनेंस** (npm + Sigstore, SLSA L2) |

पूर्ण सुरक्षा-रुख: **[SECURITY.md](./SECURITY.md)** · स्थिरता सतह: **[STABILITY.md](./STABILITY.md)** · भेद्यताएँ: `oomkapwn@gmail.com`।

---

## ❓ अक्सर पूछे जाने वाले प्रश्न

**क्या Obsidian इंस्टॉल होना चाहिए?** नहीं। `.md` + `.canvas` + `.pdf` को सीधे पढ़ता है। किसी भी Obsidian-प्रारूप vault पर काम करता है।

**क्या यह मेरे vault में लिखेगा?** नहीं, जब तक आप `--enable-write` न दें। सभी 7 लेखन टूल gated हैं; विनाशकारी टूल `dry_run` का समर्थन करते हैं।

**डेटा कहीं भेजा जाता है?** केवल `enquire-mcp install-model` पर (HuggingFace से ONNX weights डाउनलोड करता है, एक-बार)। serve मोड कभी बाहरी HTTP नहीं करता। Embeddings + reranker स्थानीय CPU पर चलते हैं।

**प्रदर्शन?** कोल्ड-बिल्ड FTS5: ~5s/1k नोट्स, ~30s/50k। BM25 क्वेरी: हमेशा <100ms। **HNSW top-10: किसी भी पैमाने पर sub-10ms।** HNSW persistence के साथ serve कोल्ड-स्टार्ट: ~50ms।

**भाषाएँ?** डिफ़ॉल्ट `paraphrase-multilingual-MiniLM-L12-v2` (50+ भाषाएँ), बहुभाषी cross-encoder। CJK / थाई / खमेर tokenization `Intl.Segmenter` के माध्यम से।

**रिमोट चला सकते हैं?** हाँ — `serve-http` उसी सर्वर को [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) पर उजागर करता है। HTTPS के लिए Tailscale Funnel या Cloudflare Tunnel के पीछे रखें। claude.ai वेब, ChatGPT कस्टम GPT, Cursor HTTP मोड, मोबाइल MCP क्लाइंट के साथ काम करता है। देखें **[docs/http-transport.md](./docs/http-transport.md)**।

---

## 🚀 रिलीज़

चैनल: `npm install @oomkapwn/enquire-mcp` → नवीनतम स्थिर (`@latest` = v3.10.x)। प्री-रिलीज़: `npm install @oomkapwn/enquire-mcp@rc` (नवीनतम release candidate)। पूर्ण changelog देखें **[CHANGELOG.md](./CHANGELOG.md)** · रोडमैप देखें **[ROADMAP.md](https://github.com/oomkapwn/enquire-mcp/blob/main/ROADMAP.md)**।

## 🤝 योगदान

issue और PR का स्वागत है। डेवलपमेंट वर्कफ़्लो देखें **[CONTRIBUTING.md](https://github.com/oomkapwn/enquire-mcp/blob/main/CONTRIBUTING.md)**; एजेंट-केंद्रित रिपॉज़िटरी विवरण देखें **[AGENTS.md](https://github.com/oomkapwn/enquire-mcp/blob/main/AGENTS.md)**।

## 📜 लाइसेंस

[MIT](./LICENSE) © Alex (@OomkaBear)
