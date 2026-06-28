<div align="center">

<a href="https://github.com/oomkapwn/enquire-mcp"><img src="./assets/social-preview.png" alt="enquire-mcp — 最先进的 Obsidian MCP。为 AI 智能体提供长期记忆。" width="100%"></a>

# enquire-mcp

<sub>[English](./README.md) · **中文** · [Español](./README.es.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md) · [Русский](./README.ru.md) · [Português](./README.pt.md) · [Français](./README.fr.md) · [日本語](./README.ja.md)</sub>

### 最先进的 Obsidian MCP。为 AI 智能体打造的长期记忆。

**别再每次会话都向 Claude、Cursor、ChatGPT、Codex、OpenClaw 重新解释上下文。你的 Obsidian 笔记成为所有 MCP 兼容智能体之间共享、可检索的记忆——你的知识，任何模型，永远属于你。**

[![npm](https://img.shields.io/npm/v/@oomkapwn/enquire-mcp.svg?label=npm&color=cb3837)](https://www.npmjs.com/package/@oomkapwn/enquire-mcp)
[![stable](https://img.shields.io/badge/v3.11.x-stable-brightgreen.svg)](./STABILITY.md)
[![build provenance](https://img.shields.io/badge/build_provenance-SLSA_L2-blue.svg)](https://slsa.dev/spec/v1.0/levels#build-l2)
[![MCP](https://img.shields.io/badge/MCP-1.29-8A2BE2.svg)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)

**[⚡ 30 秒安装](#-快速开始) · [🧠 应用场景](#-应用场景) · [📊 基准测试](./docs/benchmarks.md) · [📖 API 文档](https://oomkapwn.github.io/enquire-mcp/) · [💬 横向对比](./docs/COMPARISON.md)**

**Claude Code —— 一行命令：**

```bash
claude mcp add obsidian -- npx -y @oomkapwn/enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
```

</div>

> 📌 本文档是 [README.md](./README.md) 的中文译本，便于中文读者阅读；如有出入，**以英文版为准**（英文版随每次发布更新）。

---

## 问题

每次 AI 会话都从零开始。你一遍遍重复你的项目、你的设计决策、上周调研的结论。各家厂商的"记忆"功能（[Claude Memory](https://www.anthropic.com/news/memory-and-tool-use)、[ChatGPT Memory](https://openai.com/index/memory-and-new-controls-for-chatgpt/)、Cursor memory）把你的知识锁进某一家的云端——当你切换工具时，它又忘得一干二净。**你的知识总在重新开始。**

## 解决方案

让你的 Obsidian 仓库（vault）成为任何 MCP 兼容智能体的**持久、可查询的长期记忆**。一次安装——你的知识立即可被 Claude Code、Claude Desktop、Cursor、ChatGPT 自定义 GPT、Codex、OpenClaw 以及其他所有 MCP 客户端访问。**归你所有**的纯 markdown 文件，本地建立索引，用完整的现代信息检索（IR）技术栈检索，跨越每一次会话、每一个模型被召回。

**扎根于原文，而非抽取。** 对话记忆类工具（mem0、Zep、Supermemory、Memobase）从你的聊天记录里*抽取*事实，存进一个你读不到的独立存储。enquire-mcp 恰恰相反：它**扎根于你已经写下的知识**——你自己的 `.md` 笔记，逐字逐句，附带引用——因此召回结果可审计、可在任意编辑器中编辑，绝不是对你半记得的某次聊天的有损摘要。而与服务端**集群记忆（fleet-memory）**平台（将各智能体的流量改写进共享数据库的多租户云存储）不同，enquire 是单用户、本地优先的——一个完全归你所有、可自行读取／编辑／删除的库，serve 期间零云端调用。

**扎根——且具备时效感知。** 召回一个事实只是一半；知道它是否*仍然成立*才是另一半。[Memora 基准](https://arxiv.org/abs/2604.20006)（2026 年 4 月）表明，记忆系统普遍在"陈旧事实复用"上失败——把一年前的笔记当作今天写的来召回。因为 enquire 的记忆*就是*你真实的 markdown 文件，每条检索结果都带有从笔记最后修改时间推导出的 `age_days`（天数）与 `stale`（是否陈旧）标记，你还可开启时效加权排序（`--recency-weight`），让较新的笔记优先浮现。你的知识，具备时效感知——而非一团没有时间的混沌。

> **enquire-mcp 的与众不同之处**：
> 1. **厂商中立。** 你的记忆存在 `.md` 文件里。从 Claude 换到 Cursor——记忆随你而来。
> 2. **顶级检索。** 混合 BM25 + 多语言向量嵌入 + BGE 交叉编码器重排，经 RRF 融合，配合 HNSW + int8 量化扩展。一个搜索创业公司会搭建的同款 IR 技术栈——开源，集成在一个二进制里。
> 3. **serve 期间零云端调用。** 模型本地缓存（一次性从 HuggingFace 下载）。你的仓库内容永不离开本机。默认即可离线/隔离运行。
> 4. **时效感知召回。** 每条结果都报告笔记有多旧；可选的时效重排让智能体优先采用新知识，并把陈旧事实标记出来等待复核——这是"遗忘感知"前沿，建立在你的文件本就拥有的 `mtime` 之上。

**46 个工具 · 19 个 MCP 提示词 · 1434+ 单元测试 · 50+ 语言 · v3.11.x 稳定版 · 语义化版本约束 · MIT · npm 构建溯源（SLSA L2）。**

---

## ⚡ 快速开始

```bash
npm install -g @oomkapwn/enquire-mcp
enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
```

接入任意 MCP 客户端：

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

📂 开箱即用的配置见 [`examples/`](./examples/) —— **Claude Desktop**、**Cursor**、**ChatGPT 自定义 GPT**（通过 HTTP 的远程 MCP），以及一份评测用的示例查询集。

**想要完整的混合检索能力？** 一条命令，零配置上手：

```bash
enquire-mcp setup --vault <path>     # 下载模型，构建 FTS5 + 向量库
enquire-mcp serve --vault <path> --persistent-index --enable-reranker --use-hnsw
enquire-mcp doctor --vault <path>    # 彩色 ✓/⚠/✗ 健康检查
```

---

## 🧠 应用场景

**1 —— 为 AI 智能体提供长期记忆。** 把你的 Obsidian 仓库接入任意 MCP 兼容智能体（Claude Code、Claude Desktop、Cursor、ChatGPT、Codex、OpenClaw）。智能体随即拥有对你写过的每一条会议记录、日记、调研日志、决策文档的持久语义召回——跨会话、跨模型、跨厂商。与 `Claude Memory` 或 `ChatGPT Memory` 不同，你的知识不被锁进某家云端；它存在你拥有、可自由迁移的纯 markdown 里。

**2 —— 个人知识库 / 第二大脑。** 混合检索能为*任意*措辞、50+ 语言中的任意一种找到正确的笔记。用英文询问两年前一篇俄文日记，也能命中。Wikilink 图增强会把处于你知识图谱中心的笔记上调排名。GraphRAG-light 发现主题社群——找回你早已忘记自己建立过的联系。PDF 融入检索并带 `[page: N]` 引用，让论文和会议纪要成为一等公民记忆。

**3 —— 智能体 RAG / 上下文工程。** `obsidian_search` 暴露每路信号分数，让智能体看见每条命中*为何*这样排名。HyDE 在检索前把模糊查询改写成内容丰富的假设答案。子问题分解处理多跳问题，将其拆成相互独立的子查询再融合结果。内置评测套件（NDCG / Recall / MRR）让你在自己的查询上度量检索质量，而非盲信厂商基准。

---

## 🚫 何时 enquire-mcp 并不合适

诚实的非目标——遇到以下情况请另选工具：

- **你要的是字面 / 正则搜索。** `ripgrep` / `grep` 对"精确找这个 token"更快更准。enquire 擅长*概念性*召回——近义词、跨语言、"我关于 X 说过什么"。两者并用：字面用 `rg`，语义用 enquire。
- **你的知识在聊天记录里，而非笔记里。** enquire *扎根*于你亲手写的 markdown。从聊天记录*抽取*事实到独立存储的对话记忆工具（mem0、Zep、Supermemory）是另一个品类——见[对比](./docs/COMPARISON.md)。
- **你需要多用户 / 托管 / 同步搜索。** enquire 设计上是本地优先、单仓库的——没有服务端多租户索引。
- **你的来源不是 Markdown 或 PDF。** `.md` / `.canvas` / `.base` / `.pdf` 是一等公民；其他格式需先转换。
- **你想要图形界面或 Obsidian 内置插件。** enquire 是无界面的 MCP 服务 / CLI——它*补充* Obsidian，而非取代。（Smart Connections 是内置插件选项。）
- **你需要在数百万条笔记上做亚毫秒搜索。** HNSW 在大规模下提供 sub-10ms 的 top-K，但 enquire 面向个人 / 团队仓库，而非网页级语料。

---

## 🏆 为什么它是最好的

**六项其他 Obsidian-MCP 完全没有的能力**（GraphRAG-light、独立 `.base` 执行、HyDE、int8 量化、late-chunking、内置评测套件），**外加整套现代 IR 技术栈**（BM25 + 向量嵌入 + 交叉编码器重排 + HNSW），而竞品至多只有其中一两项。横向对比：

| 能力 | enquire-mcp | Smart Connections | 其他 Obsidian-MCP |
|---|:---:|:---:|:---:|
| 混合检索（BM25 + TF-IDF + 向量嵌入，RRF 融合） | ✅ | ❌ | ❌ |
| **交叉编码器重排**（BGE，实测 +15.5 NDCG@10） | ✅ | ❌ | ❌ |
| **HNSW 向量索引**（sub-10ms top-K，持久化） | ✅ | ❌ | ❌ |
| **int8 向量量化**（向量库体积约 1/4） | ✅ | ❌ | ❌ |
| **多语言语义搜索**（50+ 语言，本地运行） | ✅ | 💰 付费 | ❌ |
| **PDF 融入混合检索**（`[page: N]` 引用 + OCR） | ✅ | ❌ | ❌ |
| **Wikilink 图增强**检索信号 | ✅ | ❌ | ❌ |
| **内置检索质量评测套件**（NDCG、Recall、MRR） | ✅ | ❌ | ❌ |
| **远程 MCP**（HTTP + bearer 鉴权 + 有状态会话） | ✅ | ❌ | 部分 |
| **MCP 原生**（Claude · Cursor · ChatGPT · Codex · OpenClaw · 任意客户端） | ✅ | ❌ 仅 Obsidian | 不一 |
| **隐私过滤**在每条检索 + 写入路径校验 | ✅ | 不适用 | ❌ |
| **46 个生产级工具**（34 常驻读 + 4 可选 + 7 受控写 + 1 反馈） | ✅ | 不适用 | 不一 |
| **GraphRAG-light**（Louvain 模块度社群检测） | ✅ **独有** | ❌ | ❌ |
| **独立 `.base` 查询执行**（无需运行 Obsidian） | ✅ **独有** | ❌ | ❌ |
| **HyDE 检索** + 子问题分解 | ✅ **独有** | ❌ | ❌ |
| **签名构建溯源**（npm + Sigstore，SLSA L2） | ✅ | 不适用 | ❌ |
| 独立运行（无需 Obsidian 插件） | ✅ | ❌ 需 Obsidian | 不一 |
| 许可证 | MIT，免费 | 专有，付费 | 不一 |

<sub>对比基于各项目截至 v3.8.x 稳定版的公开能力。Smart Connections 是付费 Obsidian 插件（非 MCP 服务）。"其他 Obsidian-MCP"指撰写时 GitHub 上的公开开源 Obsidian-MCP 服务。enquire-mcp 的端到端检索基准发布于 <a href="./docs/benchmarks.md"><code>docs/benchmarks.md</code></a>——实测 `rerank-bge` 相对纯混合检索为 +24.7 MRR / +15.5 NDCG@10（60 条查询消融）。</sub>

> 战略定位：enquire-mcp 是构建在你现有 Obsidian 仓库之上的 [Karpathy 式 LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 的开源后端。可复利、可溯源的知识。

---

## 🏗️ 检索如何工作

`obsidian_search` 自动探测可用信号并优雅降级：BM25 / FTS5 + TF-IDF + 向量嵌入（HNSW）→ RRF 融合（k=60）→ Wikilink 图增强（α × 入度，单步个性化 PageRank）→ BGE 交叉编码器重排 → 带 `per_signal` 可观测性的排名结果。每条命中都返回 `per_signal: { bm25, tfidf, embeddings }`，让你看见它*为何*这样排名。

可分层启用，按需取用：

| 层级 | 启用方式 | 你得到什么 |
|---|---|---|
| **1** | `serve --vault <path>` | TF-IDF 余弦（零配置，即时） |
| **2** | + `--persistent-index` | + BM25 / FTS5（sub-100ms top-10） |
| **3** | + `setup`（下载模型 + 构建向量库） | + 多语言 ML 向量嵌入 |
| **4** | + `--enable-reranker` | + BGE 交叉编码器（实测 +15.5 NDCG@10） |
| **5** | + `--use-hnsw` | + 百万级 chunk 规模下 sub-10ms top-K |
| **6** | + `--include-pdfs` | + PDF 融入以上全部 |
| **7** | `serve-http --bearer-token …` | + 远程 MCP（Claude.ai 网页、ChatGPT、Cursor HTTP、移动端） |

---

## 🛠️ 全部 46 个工具

共 46 个工具：34 个常驻读（含总入口 `obsidian_search`）+ 4 个可选读 + 7 个受控写 + 1 个闭环反馈。完整参考见 **[docs/api.md](./docs/api.md)**，涵盖：搜索与检索、Wikilink 与图、Frontmatter 与 Dataview、Canvas、Obsidian Bases、PDF + OCR、社群检测、写入工具（需 `--enable-write`）等。

---

## 🛡️ 信任

| 维度 | 策略 |
|---|---|
| **默认** | 只读——7 个写工具需 `--enable-write` 才启用 |
| **最小权限** | `--disabled-tools` / `--enabled-tools` 可暴露最小工具面（如只读研究智能体仅获 `obsidian_search` + `obsidian_read_note`） |
| **路径安全** | 每次读写都做 realpath 校验；拒绝指向仓库外的符号链接 |
| **隐私过滤** | 在 FTS5 + 向量库 + chunk 资源路径校验；空白名/黑名单时按"失败即拒绝"处理 |
| **HTTP 传输** | Bearer 鉴权（常量时间 SHA-256 + `timingSafeEqual`）、按 token 限流、严格 CORS |
| **构建发布** | 每个 tag 发布到 npm + GitHub Release · 语义化版本 · **签名构建溯源**（npm + Sigstore，SLSA L2） |

完整安全模型见 **[SECURITY.md](./SECURITY.md)** · 稳定性边界见 **[STABILITY.md](./STABILITY.md)** · 漏洞反馈：`oomkapwn@gmail.com`。

---

## ❓ 常见问题

**需要安装 Obsidian 吗？** 不需要。直接读取 `.md` + `.canvas` + `.pdf`。可对任意 Obsidian 格式的仓库工作。

**会写入我的仓库吗？** 除非你传 `--enable-write`，否则不会。全部 7 个写工具受控；破坏性操作支持 `dry_run`。

**会把数据发到哪里吗？** 仅在 `enquire-mcp install-model` 时（一次性从 HuggingFace 下载 ONNX 权重）。serve 模式从不发起对外 HTTP。向量嵌入与重排都在本地 CPU 运行。

**性能如何？** 冷构建 FTS5：约 5s/1k 笔记、约 30s/50k。BM25 查询：始终 <100ms。**HNSW top-10：任意规模 sub-10ms。** 启用 HNSW 持久化时 serve 冷启动约 50ms。

**支持哪些语言？** 默认 `paraphrase-multilingual-MiniLM-L12-v2`（50+ 语言），多语言交叉编码器。CJK / 泰文 / 高棉文分词通过 `Intl.Segmenter`。

**能远程运行吗？** 可以——`serve-http` 通过 [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) 暴露同一个服务。用 Tailscale Funnel 或 Cloudflare Tunnel 套 HTTPS。可配合 claude.ai 网页、ChatGPT 自定义 GPT、Cursor HTTP 模式、移动端 MCP 客户端。见 **[docs/http-transport.md](./docs/http-transport.md)**。

---

## 🚀 发布

通道：`npm install @oomkapwn/enquire-mcp` → 最新稳定版（`@latest` = v3.11.x）。预览版：`npm install @oomkapwn/enquire-mcp@rc`（最新候选版）。完整变更日志见 **[CHANGELOG.md](./CHANGELOG.md)** · 路线图见 **[ROADMAP.md](https://github.com/oomkapwn/enquire-mcp/blob/main/ROADMAP.md)**。

## 🤝 参与贡献

欢迎 issue 与 PR。开发工作流见 **[CONTRIBUTING.md](https://github.com/oomkapwn/enquire-mcp/blob/main/CONTRIBUTING.md)**；面向智能体的仓库说明见 **[AGENTS.md](https://github.com/oomkapwn/enquire-mcp/blob/main/AGENTS.md)**。

## 📜 许可证

[MIT](./LICENSE) © Alex (@OomkaBear)
