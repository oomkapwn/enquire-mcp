<div align="center">

<a href="https://github.com/oomkapwn/enquire-mcp"><img src="./assets/social-preview.png" alt="enquire-mcp — सबसे उन्नत Obsidian MCP। AI एजेंट्स के लिए दीर्घकालिक स्मृति।" width="100%"></a>

# enquire-mcp

<sub>[English](./README.md) · [中文](./README.zh.md) · [Español](./README.es.md) · **हिन्दी** · [العربية](./README.ar.md) · [Русский](./README.ru.md) · [Português](./README.pt.md) · [Français](./README.fr.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Deutsch](./README.de.md)</sub>

### सबसे उन्नत Obsidian MCP। AI एजेंट्स के लिए बनी दीर्घकालिक स्मृति।

**हर सत्र में Claude, Cursor, ChatGPT, Codex, OpenClaw को संदर्भ दोबारा समझाना बंद करें। आपके Obsidian नोट्स हर MCP-संगत एजेंट के बीच साझा, खोजने-योग्य स्मृति बन जाते हैं — आपका ज्ञान, हर मॉडल, हमेशा आपका अपना।**

*मापा गया: BGE cross-encoder reranker एक [पुनरुत्पादनीय 60-क्वेरी ablation](./docs/benchmarks.md) पर सादे हाइब्रिड की तुलना में **+15.5 NDCG@10 / +24.7 MRR** जोड़ता है — पूरा आधुनिक IR स्टैक, जो उसी markdown को याद करता है जो **आपने** लिखी (उद्धृत, संपादन-योग्य), कभी कोई क्लाउड पैराफ़्रेज़ नहीं।*

[![npm](https://img.shields.io/npm/v/@oomkapwn/enquire-mcp.svg?label=npm&color=cb3837)](https://www.npmjs.com/package/@oomkapwn/enquire-mcp)
[![stable](https://img.shields.io/badge/v3.11.x-stable-brightgreen.svg)](./STABILITY.md)
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

**मूल पर आधारित, निकाला हुआ नहीं।** बातचीत-स्मृति टूल (mem0, Zep, Supermemory, Memobase) आपके चैट लॉग से तथ्य *निकालकर* एक अलग स्टोर में रखते हैं जिसे आप पढ़ नहीं सकते। enquire-mcp इसका उल्टा है: यह **उस ज्ञान पर आधारित है जो आपने पहले से लिखा है** — आपके अपने `.md` नोट्स, शब्दशः, उद्धरणों सहित — इसलिए recall ऑडिट-योग्य है, किसी भी एडिटर में संपादन-योग्य है, और कभी भी किसी आधी-याद बातचीत का हानिपूर्ण सारांश नहीं होता। और सर्वर-साइड ***fleet*-memory** प्लेटफ़ॉर्म्स (मल्टी-टेनेंट क्लाउड स्टोर जो एजेंट ट्रैफ़िक को एक साझा डेटाबेस में पैराफ़्रेज़ कर देते हैं) के विपरीत, enquire **एकल-उपयोगकर्ता और स्थानीय-प्रथम** है: एक ऐसा vault जो पूरी तरह आपका है और जिसे आप स्वयं पढ़, संपादित और हटा सकते हैं, serve के दौरान शून्य क्लाउड कॉल के साथ। (वह "निकाला हुआ" आलोचना विशेष रूप से चैट-स्मृति वर्ग पर लागू होती है — cognee जैसे ज्ञान-ग्राफ़ / ETL टूल पर नहीं, और न ही Khoj जैसे व्यक्तिगत-खोज साथियों पर।)

**मूल पर आधारित — और ताज़गी के प्रति सजग।** किसी तथ्य को याद करना आधी समस्या है; यह जानना कि वह अब भी *सही* है या नहीं, बाकी आधी है। [Memora बेंचमार्क](https://arxiv.org/abs/2604.20006) (अप्रैल 2026) ने दिखाया कि स्मृति प्रणालियाँ व्यवस्थित रूप से बासी-तथ्य पुनरुपयोग में विफल रहती हैं — एक साल पुराने नोट को ऐसे याद करती हैं मानो वह आज ही लिखा गया हो। चूँकि enquire की स्मृति *ही* आपकी असली markdown फ़ाइलें हैं, इसलिए हर खोज-परिणाम के साथ नोट के लाइव अंतिम-संशोधन समय से व्युत्पन्न `age_days` + एक `stale` फ़्लैग आता है, और आप recency-भारित रैंकिंग (`--recency-weight`) चुन सकते हैं ताकि ताज़ा नोट्स पहले सामने आएँ। आपका ज्ञान, ताज़गी के प्रति सजग — न कि एक कालातीत ढेर।

> **enquire-mcp को अलग क्या बनाता है**:
> 1. **विक्रेता-तटस्थ।** आपकी स्मृति `.md` फ़ाइलों में रहती है। Claude से Cursor पर जाएँ — आपकी स्मृति आपके साथ आती है।
> 2. **श्रेणी में सर्वश्रेष्ठ retrieval।** हाइब्रिड BM25 + बहुभाषी embeddings + BGE cross-encoder reranker, RRF के माध्यम से fused, HNSW + int8 quantization के साथ स्केल्ड। वही IR स्टैक जो एक सर्च स्टार्टअप बनाता — ओपन-सोर्स, एक ही बाइनरी में।
> 3. **serve के दौरान शून्य क्लाउड कॉल।** embedding मॉडल **आपकी मशीन पर** चलता है और उसी markdown को अनुक्रमित करता है जो **आपने** लिखी — इसीलिए यह एक-बार का स्थानीय डाउनलोड (~110 MB) है, न कि कोई क्लाउड API key। मूल-आधारित + निजी होना मुफ़्त नहीं है, और हम इसका दिखावा नहीं करते: आपके vault की सामग्री कभी आपकी मशीन नहीं छोड़ती, डिफ़ॉल्ट रूप से एयर-गैप-सुरक्षित ([प्रवर्तित](./SECURITY.md), केवल आकांक्षात्मक नहीं)।
> 4. **ताज़गी-सजग recall।** हर परिणाम बताता है कि नोट कितना पुराना है; वैकल्पिक recency re-ranking एजेंट को ताज़ा ज्ञान को प्राथमिकता देने और बासी तथ्यों को पुनः-सत्यापन हेतु चिह्नित करने देता है — भूलने-के-प्रति-सजग सीमांत, जो आपकी फ़ाइलों में पहले से मौजूद `mtime` पर बना है।

**46 टूल · 19 MCP प्रॉम्प्ट · 1552+ यूनिट टेस्ट · 50+ भाषाएँ · v3.11.x स्थिर · semver-बाध्य · MIT · npm बिल्ड प्रोवेनेंस (SLSA L2)।**

---

## 🏆 यह सर्वश्रेष्ठ क्यों है

**छह क्षमताएँ जो किसी अन्य Obsidian-MCP में बिल्कुल नहीं हैं** (GraphRAG-light, स्वतंत्र `.base` निष्पादन, HyDE, int8 quantization, late-chunking, अंतर्निहित eval harness), **साथ ही पूरा आधुनिक IR स्टैक** (BM25 + ML embeddings + cross-encoder reranking + HNSW), जबकि प्रतिस्पर्धी अधिक-से-अधिक एक-दो ही देते हैं। साथ-साथ तुलना:

| क्षमता | enquire-mcp | Smart Connections | अन्य Obsidian-MCP |
|---|:---:|:---:|:---:|
| हाइब्रिड retrieval (BM25 + TF-IDF + ML embeddings, RRF-fused) | ✅ | ❌ | ❌ |
| **Cross-encoder reranking** (BGE, मापा गया +15.5 NDCG@10) | ✅ | ❌ | ❌ |
| **HNSW वेक्टर इंडेक्स** (sub-10ms top-K, persisted) | ✅ | ❌ | ❌ |
| **int8 वेक्टर quantization** (~4× छोटी embed-db) | ✅ | ❌ | ❌ |
| **Late-chunking** संदर्भ-विंडो वाले embeddings | ✅ | ❌ | ❌ |
| **हाइब्रिड खोज में घुले PDF** (`[page: N]` उद्धरण) | ✅ | ❌ | ❌ |
| **स्कैन किए गए PDF के लिए OCR** (Tesseract.js, बहुभाषी) | ✅ | ❌ | ❌ |
| **Wikilink ग्राफ़-बूस्ट** retrieval संकेत | ✅ | ❌ | ❌ |
| **बहुभाषी सिमेंटिक खोज** (50+ भाषाएँ, ऑन-डिवाइस) | ✅ | 💰 भुगतान | ❌ |
| **अंतर्निहित retrieval-गुणवत्ता eval harness** (NDCG, Recall, MRR, A/B मैट्रिक्स) | ✅ | ❌ | ❌ |
| **रिमोट MCP** (HTTP + bearer auth + stateful sessions) | ✅ | ❌ | आंशिक |
| **प्रति-संकेत observability** प्रति हिट | ✅ | ❌ | ❌ |
| **MCP-नेटिव** (Claude · Cursor · ChatGPT · Codex · OpenClaw · कोई भी क्लाइंट) | ✅ | ❌ केवल Obsidian | भिन्न |
| **प्राइवेसी फ़िल्टर** हर खोज + लेखन पथ पर सत्यापित | ✅ | लागू नहीं | ❌ |
| **46 प्रोडक्शन टूल** (34 हमेशा-चालू read + 4 opt-in + 7 gated writes + 1 फ़ीडबैक) | ✅ | लागू नहीं | भिन्न |
| **GraphRAG-light** (Louvain modularity wikilink समुदाय-पहचान) | ✅ **केवल यहीं** | ❌ | ❌ |
| **स्वतंत्र `.base` क्वेरी निष्पादन** (Obsidian चले बिना काम करता है) | ✅ **केवल यहीं** | ❌ | ❌ Obsidian को सौंपता है |
| **HyDE retrieval** (Gao et al 2023) + उप-प्रश्न विघटन | ✅ **केवल यहीं** | ❌ | ❌ |
| **1552 यूनिट टेस्ट · प्रति PR 9 आवश्यक + 5 सलाहकारी CI गेट** | ✅ | लागू नहीं | विरल |
| **साइन्ड बिल्ड प्रोवेनेंस** (npm + Sigstore, SLSA Build L2) | ✅ | लागू नहीं | ❌ |
| **semver-बाध्य सार्वजनिक सतह** ([STABILITY.md](./STABILITY.md)) | ✅ | लागू नहीं | ❌ |
| स्वतंत्र (कोई Obsidian प्लगइन ज़रूरी नहीं) | ✅ | ❌ Obsidian ज़रूरी | भिन्न |
| लाइसेंस | MIT, मुफ़्त | प्रोप्राइटरी, भुगतान | भिन्न |

<sub>तुलना प्रत्येक परियोजना की v3.8.x स्थिर तक की सार्वजनिक क्षमताओं पर आधारित है (प्रारंभिक स्नैपशॉट v3.7.0 / 2026-05-15; v3.8.4 में अद्यतन)। Smart Connections एक भुगतान वाला Obsidian प्लगइन है (MCP सर्वर नहीं)। "अन्य Obsidian-MCP" से तात्पर्य लेखन के समय GitHub पर मौजूद सार्वजनिक ओपन-सोर्स Obsidian-MCP सर्वरों से है। enquire-mcp के एंड-टू-एंड retrieval बेंचमार्क <a href="./docs/benchmarks.md"><code>docs/benchmarks.md</code></a> में प्रकाशित हैं — मापा गया `rerank-bge` अंतर 60-क्वेरी ablation पर सादे हाइब्रिड की तुलना में +24.7 MRR / +15.5 NDCG@10 है।</sub>

> रणनीतिक दावा: enquire-mcp आपके मौजूदा Obsidian vault के ऊपर [Karpathy-शैली LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) के लिए ओपन-सोर्स बैकएंड है। ऐसा ज्ञान जो चक्रवृद्धि होता है, स्रोतों तक खोज-योग्य।

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

## 🤖 अपने AI एजेंट में सेटअप करें — कॉपी-पेस्ट प्रॉम्प्ट

जब `enquire-mcp` इंस्टॉल हो जाए, तो इन प्रॉम्प्ट्स को अपने एजेंट में पेस्ट करें ताकि उसे पता चले कि vault स्मृति के रूप में उपलब्ध है।

<details>
<summary><b>Claude Code (टर्मिनल)</b> — MCP सर्वर जोड़ें + पहला प्रॉम्प्ट</summary>

```bash
# MCP सर्वर को अपने Claude Code कॉन्फ़िग में जोड़ें (एक बार)
claude mcp add obsidian -- npx -y @oomkapwn/enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
```

फिर किसी भी Claude Code सत्र में:

> अब आपके पास `obsidian_*` टूल हैं जो मेरे Obsidian vault — मेरी दीर्घकालिक स्मृति — को खोजते और पढ़ते हैं। परियोजनाओं, निर्णयों, लोगों या तकनीकी संदर्भ के बारे में प्रश्नों का उत्तर देने से पहले, प्रासंगिक शब्दों के साथ `obsidian_search` को कॉल करें। हर तथ्य को स्रोत नोट के साथ उद्धृत करें (और PDF के लिए `[page: N]`)। यदि आपको कोई प्रासंगिक नोट न मिले, तो ऐसा कहें — अनुमान न लगाएँ।

</details>

<details>
<summary><b>Claude Desktop</b> — कॉन्फ़िग फ़ाइल + पहला प्रॉम्प्ट</summary>

[`examples/claude-desktop-hybrid.json`](./examples/claude-desktop-hybrid.json) को Claude Desktop के MCP कॉन्फ़िग में डालें (पहले vault पथ संपादित करें)। Claude Desktop को पुनः आरंभ करें, फिर:

> आपके पास मेरा Obsidian vault `obsidian_*` टूल के माध्यम से खोजने-योग्य स्मृति के रूप में जुड़ा हुआ है। जब भी मैं अपने नोट्स में किसी भी चीज़ के बारे में पूछूँ — मीटिंग संदर्भ, शोध, निर्णय, जर्नल प्रविष्टियाँ — हमेशा पहले `obsidian_search` जाँचें। हर तथ्य पर स्रोत नोट का पथ उद्धृत करें।

</details>

<details>
<summary><b>Cursor</b> — MCP stdio कॉन्फ़िग + एजेंट नियम</summary>

[`examples/cursor-mcp.json`](./examples/cursor-mcp.json) को `~/.cursor/mcp.json` पर डालें (vault पथ संपादित करें)। अपनी `.cursorrules` फ़ाइल या चैट में:

> ऐसा कोड सुझाने से पहले जो किसी ऐसे विषय को छूता हो जिस पर मेरे नोट्स हो सकते हैं (आर्किटेक्चर निर्णय, API अनुबंध, विक्रेता मूल्यांकन), पहले `obsidian_search` को कॉल करें। मेरे Obsidian vault को आधिकारिक संदर्भ मानें।

</details>

<details>
<summary><b>ChatGPT कस्टम GPT</b> — HTTP पर रिमोट MCP</summary>

bearer auth के साथ टनल के माध्यम से `serve-http` को उजागर करने के लिए [`examples/chatgpt-actions.md`](./examples/chatgpt-actions.md) का पालन करें। अपने कस्टम GPT के निर्देशों में:

> आपके पास `obsidian_*` टूल परिवार के माध्यम से मेरे Obsidian vault तक पठन-पहुँच है। ऐसी किसी भी चीज़ का उत्तर देने से पहले खोजें जो मेरे नोट्स में हो सकती है; हर दावे पर स्रोत फ़ाइलपथ उद्धृत करें।

</details>

<details>
<summary><b>OpenClaw / Codex / कोई अन्य MCP क्लाइंट</b></summary>

वही `npx -y @oomkapwn/enquire-mcp serve --vault <path>` कमांड किसी भी MCP-संगत क्लाइंट के लिए काम करती है। सर्वर एंट्री कहाँ डालनी है, यह जानने के लिए क्लाइंट के अपने MCP-कॉन्फ़िग दस्तावेज़ देखें, फिर ऊपर दिए गए किसी भी प्रॉम्प्ट का उपयोग करें।

</details>

**पुन: प्रयोज्य एजेंट नियम** (किसी भी `AGENTS.md` / `CLAUDE.md` / `.cursorrules` में डालें ताकि एजेंट जान सके कि vault का सहारा *कब* लेना है):

> जब मेरा प्रश्न मेरे अपने नोट्स, निर्णयों, परियोजनाओं, लोगों या शोध को छूता हो, तो **पहले मेरे Obsidian vault में खोजें** `obsidian_*` टूल के माध्यम से (`obsidian_search` से शुरू करें) और हर तथ्य पर स्रोत नोट उद्धृत करें। *वैचारिक / क्रॉस-लैंग्वेज / "मैंने X के बारे में क्या कहा"* recall के लिए enquire को प्राथमिकता दें; सटीक शाब्दिक स्ट्रिंग के लिए सादा `grep` / `ripgrep` उपयोग करें। यदि कुछ भी प्रासंगिक न लौटे, तो ऐसा कहें — अनुमान न लगाएँ।

### उदाहरण क्वेरियाँ जो अच्छी तरह काम करती हैं

- *"हर वह नोट ढूँढो जहाँ मैंने मूल्य-निर्धारण रणनीति पर चर्चा की, विकास का सारांश दो।"* — RRF fusion + reranker "विकास" को सिमेंटिक रूप से संभालता है
- *"PostgreSQL बनाम MongoDB पर मेरा निर्णय क्या था? डेली नोट उद्धृत करो।"* — wikilink ग्राफ़-बूस्ट केंद्रीय निर्णय दस्तावेज़ को सामने लाता है
- *"Анализируй мои заметки о RAG за последние 3 месяца"* — बहुभाषी embeddings + frontmatter तिथि फ़िल्टर
- *"LLaMA-3 पेपर PDF के कौन-से पृष्ठ स्केलिंग की बात करते हैं?"* — `[page: N]` उद्धरणों के साथ खोज में घुले PDF
- *"मेरे शोध vault में विषयगत समुदाय दिखाओ — मैं किन विषयों की खोज कर रहा हूँ?"* — `obsidian_get_communities` (GraphRAG-light)

---

## 🧠 उपयोग के मामले

**1 — AI एजेंट्स के लिए दीर्घकालिक स्मृति।** अपने Obsidian vault को किसी भी MCP-संगत एजेंट (Claude Code, Claude Desktop, Cursor, ChatGPT, Codex, OpenClaw) में जोड़ें। एजेंट के पास अब आपके लिखे हर मीटिंग नोट, जर्नल प्रविष्टि, शोध लॉग और निर्णय दस्तावेज़ पर टिकाऊ, सिमेंटिक recall होता है — सत्रों, मॉडलों और प्रदाताओं के पार। `Claude Memory` या `ChatGPT Memory` के विपरीत, आपका ज्ञान किसी एक विक्रेता के क्लाउड में बंद नहीं होता; यह सादे markdown में रहता है जो आपका अपना है और जिसे आप स्वतंत्र रूप से माइग्रेट कर सकते हैं।

**2 — व्यक्तिगत ज्ञान-आधार / दूसरा दिमाग।** हाइब्रिड retrieval *किसी भी* शब्द-रचना के लिए, 50+ भाषाओं में से किसी में भी, सही नोट सामने लाता है। दो साल पुरानी रूसी-भाषा जर्नल प्रविष्टि के बारे में अंग्रेज़ी में पूछें, सही हिट पाएँ। Wikilink ग्राफ़-बूस्ट उन नोट्स को री-रैंक करता है जो आपके ज्ञान-ग्राफ़ के केंद्र में बैठे हैं। GraphRAG-light विषयगत समुदायों को सामने लाता है — उन संबंधों की खोज करें जिन्हें बनाना आप भूल गए थे। PDF `[page: N]` उद्धरणों के साथ खोज में घुल-मिल जाते हैं ताकि शोध-पत्र और मीटिंग ट्रांसक्रिप्ट प्रथम-श्रेणी स्मृति बन जाएँ।

**3 — एजेंटिक RAG / संदर्भ इंजीनियरिंग।** `obsidian_search` प्रति-संकेत स्कोर उजागर करता है ताकि एजेंट देख सके कि हर हिट *क्यों* रैंक हुई। HyDE retrieval से पहले अस्पष्ट क्वेरियों को समृद्ध काल्पनिक उत्तरों में पुनः-लिखता है। उप-प्रश्न विघटन बहु-हॉप प्रश्नों ("हमारी मूल्य-निर्धारण रणनीति कैसे विकसित हुई और ग्राहक की प्रतिक्रिया क्या थी?") को स्वतंत्र उप-क्वेरियों में तोड़कर, परिणाम fuse करके संभालता है। अंतर्निहित eval harness (NDCG / Recall / MRR) आपको विक्रेता बेंचमार्क पर भरोसा करने के बजाय अपनी क्वेरियों पर retrieval गुणवत्ता मापने देता है।

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

## 📖 API संदर्भ

स्वचालित रूप से उत्पन्न **[oomkapwn.github.io/enquire-mcp पर API संदर्भ](https://oomkapwn.github.io/enquire-mcp/)** — हर टूल, प्रॉम्प्ट और निर्यातित helper के साथ पूर्ण TSDoc (`@param` / `@returns` / `@example`)। हर `main` पर push के साथ स्रोत से [`publish-docs.yml`](https://github.com/oomkapwn/enquire-mcp/blob/main/.github/workflows/publish-docs.yml) (TypeDoc → GitHub Pages) के माध्यम से पुनर्निर्मित। निर्माण-द्वारा बहाव-मुक्त: वही TSDoc जो AI एजेंट और IDE देखते हैं, वही प्रकाशित होता है।

---

## 🏗️ Retrieval कैसे काम करता है

```mermaid
graph LR
    Q[Query] --> S[obsidian_search]
    S --> BM25[BM25 / FTS5]
    S --> TFIDF[TF-IDF cosine]
    S --> EMB[ML embeddings<br/>HNSW]
    BM25 --> RRF{RRF fusion<br/>k=60}
    TFIDF --> RRF
    EMB --> RRF
    RRF --> GB[Graph boost<br/>α × in-degree]
    GB --> RR[BGE cross-encoder<br/>reranker]
    RR --> R[Ranked hits<br/>per_signal observability]
```

`obsidian_search` उपलब्ध संकेतों का स्वचालित पता लगाता है और सुंदरता से degrade होता है। Wikilink ग्राफ़-बूस्ट सिंगल-स्टेप personalised PageRank के माध्यम से top-K को री-रैंक करता है। वैकल्पिक cross-encoder reranking top-N को पुनः स्कोर करता है, मापा गया +15.5 NDCG@10। हर हिट `per_signal: { bm25, tfidf, embeddings }` लौटाता है ताकि आप देख सकें कि वह *क्यों* रैंक हुई।

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

कुल 46 टूल: 34 हमेशा-चालू read (अम्ब्रेला `obsidian_search` सहित) + 4 opt-in read + 7 gated writes + 1 क्लोज़्ड-लूप फ़ीडबैक। पूर्ण संदर्भ: **[docs/api.md](./docs/api.md)**।

| श्रेणी | टूल |
|---|---|
| **खोज व retrieval** | `obsidian_search` (अम्ब्रेला, RRF-fused) · `obsidian_hyde_search` (HyDE-संवर्धित, v3.1.0) · `obsidian_search_text` · `obsidian_full_text_search` · `obsidian_semantic_search` · `obsidian_embeddings_search` · `obsidian_find_similar` |
| **Wikilinks व ग्राफ़** | `obsidian_resolve_wikilink` · `obsidian_get_backlinks` · `obsidian_get_outbound_links` · `obsidian_get_note_neighbors` · `obsidian_get_unresolved_wikilinks` · `obsidian_find_path` · `obsidian_get_communities` (v3.4.0, GraphRAG-light) |
| **Frontmatter व Dataview** | `obsidian_frontmatter_get` · `obsidian_frontmatter_search` · `obsidian_dataview_query` · `obsidian_list_tags` |
| **पढ़ना व नेविगेट** | `obsidian_read_note` · `obsidian_list_notes` · `obsidian_get_recent_edits` · `obsidian_stale_notes` · `obsidian_open_questions` · `obsidian_context_pack` · `obsidian_chat_thread_read` · `obsidian_open_in_ui` · `obsidian_stats` |
| **PDF, Canvas व Bases** | `obsidian_read_pdf` · `obsidian_list_pdfs` · `obsidian_ocr_pdf` · `obsidian_read_canvas` · `obsidian_list_canvases` · `obsidian_list_bases` (v3.2.0) · `obsidian_read_base` (v3.2.0) · `obsidian_query_base` (v3.2.0) |
| **लेखन** (`--enable-write` द्वारा gated) | `obsidian_create_note` · `obsidian_append_to_note` · `obsidian_rename_note` · `obsidian_replace_in_notes` · `obsidian_archive_note` · `obsidian_frontmatter_set` · `obsidian_chat_thread_append` |
| **डायग्नोस्टिक / lint** | `obsidian_lint_wiki` · `obsidian_paper_audit` · `obsidian_validate_note_proposal` |
| **फ़ीडबैक** (`--feedback-weight` के माध्यम से opt-in) | `obsidian_mark_useful` (क्लोज़्ड-लूप: रिकॉर्ड करें कि कौन-से याद किए गए नोट्स काम आए; भविष्य की खोज में उन्हें बूस्ट करता है) |

इसके अलावा 3 MCP resources (`obsidian://vault/info`, `obsidian://note/{path}`, `obsidian://chunk/{n}/{path}`) और सामान्य vault वर्कफ़्लो के लिए 19 **MCP प्रॉम्प्ट** (`summarize_recent_edits` · `review_tag` · `find_orphans` · `weekly_review` · `extract_todos` · `process_inbox` · `consolidate_tags` · `find_duplicates` · `lint_wiki` · `monthly_review` · `search_with_query_expansion` · `vault_synth` · `vault_wiki_compile` · `vault_lint_extended` · `vault_capture` · `vault_persona_search` · `vault_automation_setup` · `vault_research` · `vault_synthesis_page`)।

---

## 🛡️ भरोसा

| पहलू | रुख |
|---|---|
| **डिफ़ॉल्ट** | केवल-पठन — 7 लेखन टूल के लिए `--enable-write` ज़रूरी |
| **न्यूनतम विशेषाधिकार** | `--disabled-tools` / `--enabled-tools` एक न्यूनतम सतह उजागर करते हैं (जैसे केवल-पठन शोध एजेंट को सिर्फ़ `obsidian_search` + `obsidian_read_note` मिलता है) |
| **पथ सुरक्षा** | हर read+write पर realpath जाँच; vault से बाहर जाने वाले symlinks अस्वीकृत |
| **प्राइवेसी फ़िल्टर** | FTS5 + embed-db + chunk resource पथों पर सत्यापित; खाली allow-/deny-list पर fail-closed |
| **HTTP ट्रांसपोर्ट** | Bearer auth (constant-time SHA-256 + `timingSafeEqual`), प्रति-token rate-limit, सख़्त CORS |
| **Frontmatter** | `js-yaml@5` `load` (YAML 1.2 core schema, डिफ़ॉल्ट रूप से सुरक्षित) — कोई कोड निष्पादन नहीं |
| **कैश + इंडेक्स फ़ाइलें** | chmod 0600, पैरेंट डायरेक्टरी 0700 |
| **CI** | **9 आवश्यक** branch-protection गेट: (1) `lint`, (2) `test` Node 22 पर, (3) `test` Node 24 पर, (4) `smoke`, (5) `audit`, (6) `coverage`, (7) `version-consistency`, (8) `docs`, (9) `oia`। **5 सलाहकारी**: `test-macos` + `docker` (Dockerfile बिल्ड + `tools/list` introspection smoke) `.github/workflows/ci.yml` के माध्यम से; CodeQL ×2 + Analyze actions [GitHub default-setup](https://docs.github.com/code-security/code-scanning/automatically-scanning-your-code-for-vulnerabilities-and-errors/configuring-default-setup-for-code-scanning) के माध्यम से (workflow फ़ाइलें नहीं)। npm प्रकाशन से पहले रिलीज़ वर्कफ़्लो टैग्ड SHA पर सभी 9 आवश्यक गेट के पास होने की पुनः जाँच करता है। |
| **कवरेज** | लाइनें ≥86% · statements ≥82% · functions ≥75% · branches ≥74% (gated) |
| **रिलीज़** | प्रति tag npm + GitHub release · semver · **साइन्ड बिल्ड प्रोवेनेंस** (npm + Sigstore, SLSA Build L2; L3 जनरेटर रोडमैप पर) |
| **स्थिरता** | v3.0+ semver-बाध्य — हर CLI flag, टूल नाम, MCP resource, prompt, निर्यातित symbol एक अनुबंध है |

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

**v3.0.0 — स्थिर चैनल।** v2.x retrieval रोडमैप पूर्ण हो चुका है और सार्वजनिक सतह अब [semver-बाध्य](./STABILITY.md) है। चुनिंदा झलक:

`v2.0` हाइब्रिड retrieval (BM25+TF-IDF+embeddings, RRF के माध्यम से) · `v2.6` रिमोट MCP · `v2.7-2.8` PDF घुले · `v2.9` BGE reranker · `v2.10` OCR · `v2.11` doctor + setup · `v2.12` eval harness · `v2.13` HNSW · `v2.14` stateful sessions · `v2.15` late-chunking · `v2.16` HNSW persistence · `v2.17` int8 quantization · `v3.8.0` स्थिर · `v3.8.7` HTTP ट्रांसपोर्ट हार्डनिंग · **`v3.9.0` स्थिर**: OCR'd PDF watcher embed-sync, फ़ाइल बदलावों पर HNSW इन-मेमोरी लाइव अपडेट, R-10 अनुकूली HNSW refill (>66% बहिष्कृत under-return को बंद करता है)। · **`v3.10` स्थिर**: भूलने-के-प्रति-सजग ताज़गी — `age_days` + `stale` फ़्लैग + opt-in `--recency-weight` री-रैंकिंग + frontmatter-सजग `obsidian_search`।

चैनल: `npm install @oomkapwn/enquire-mcp` → नवीनतम स्थिर (`@latest` = v3.11.x)। प्री-रिलीज़: `npm install @oomkapwn/enquire-mcp@rc` (नवीनतम release candidate — देखें [CHANGELOG.md](./CHANGELOG.md))। पूर्ण changelog: **[CHANGELOG.md](./CHANGELOG.md)** · आगे की योजना: **[ROADMAP.md](https://github.com/oomkapwn/enquire-mcp/blob/main/ROADMAP.md)**।

---

## 🤝 योगदान

```bash
git clone https://github.com/oomkapwn/enquire-mcp.git
cd enquire-mcp && npm install
npm test       # पूर्ण सूट (1552 टेस्ट, ~12s)
npm run lint   # ज़ीरो वॉर्निंग
npm run build  # tsc → dist/
```

issue, PR, और विचारों का स्वागत है। ब्रांच सुरक्षा `main` पर PR समीक्षा की मांग करती है। डेवलपमेंट वर्कफ़्लो देखें **[CONTRIBUTING.md](https://github.com/oomkapwn/enquire-mcp/blob/main/CONTRIBUTING.md)**; एजेंट-केंद्रित रिपॉज़िटरी विवरण देखें **[AGENTS.md](https://github.com/oomkapwn/enquire-mcp/blob/main/AGENTS.md)**।

---

## 📜 लाइसेंस

[MIT](./LICENSE) © Alex (@OomkaBear)
