<div align="center">

<a href="https://github.com/oomkapwn/enquire-mcp"><img src="./assets/social-preview.png" alt="enquire-mcp — AI 메모리를 위한 #1 Obsidian MCP." width="100%"></a>

# enquire-mcp

<sub>[English](./README.md) · [中文](./README.zh.md) · [Español](./README.es.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md) · [Русский](./README.ru.md) · [Português](./README.pt.md) · [Français](./README.fr.md) · [日本語](./README.ja.md) · **한국어** · [Deutsch](./README.de.md)</sub>

<sub>**AI 에이전트를 위한 요약(TL;DR)** — 로컬 Obsidian 마크다운 Vault를 Claude Code, Claude Desktop, Cursor, ChatGPT, Codex, OpenClaw에 영속적이고 검색 가능한 기억으로 노출하는 MCP 서버. 하이브리드 검색(BM25 + ML 임베딩 + BGE 리랭커, RRF 융합), HNSW + int8 양자화, 에이전트형 RAG(HyDE + 하위 질문), GraphRAG-light, PDF + OCR, 독립 실행형 Bases. 벤더 중립, MIT, serve 중 클라우드 호출 0건. 설치: `npm i -g @oomkapwn/enquire-mcp`. 문서: [llms.txt](https://github.com/oomkapwn/enquire-mcp/blob/main/llms.txt) · [AGENTS.md](https://github.com/oomkapwn/enquire-mcp/blob/main/AGENTS.md) · [API](https://oomkapwn.github.io/enquire-mcp/api/).</sub>

### 🏆 AI 메모리를 위한 #1 Obsidian MCP.

**세션마다 Claude, Cursor, ChatGPT, Codex, OpenClaw에 컨텍스트를 다시 설명하는 일을 멈추세요. 당신의 Obsidian 노트가 MCP 호환 에이전트 전체에서 공유되고 검색 가능한 기억이 됩니다 — 당신의 지식, 모든 모델, 영원히 당신의 것.**

*측정 결과: BGE 크로스 인코더 리랭커는 [재현 가능한 60개 쿼리 어블레이션](./docs/benchmarks.md)에서 일반 하이브리드 대비 **+15.5 NDCG@10 / +24.7 MRR**을 더합니다 — 완전한 최신 IR 스택으로, **당신이** 직접 작성한 마크다운을 다시 불러옵니다(출처 인용 가능, 편집 가능). 클라우드의 의역이 아닙니다.*

[![CI](https://github.com/oomkapwn/enquire-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/oomkapwn/enquire-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@oomkapwn/enquire-mcp.svg?label=npm&color=cb3837)](https://www.npmjs.com/package/@oomkapwn/enquire-mcp)
[![downloads](https://img.shields.io/npm/dm/@oomkapwn/enquire-mcp.svg?color=cb3837)](https://www.npmjs.com/package/@oomkapwn/enquire-mcp)
[![tests](https://img.shields.io/badge/tests-1720%20passing-brightgreen.svg)](#️-신뢰)
[![stable](https://img.shields.io/badge/v3.11.x-stable-brightgreen.svg)](./STABILITY.md)
[![build provenance](https://img.shields.io/badge/build_provenance-SLSA_L2-blue.svg)](https://slsa.dev/spec/v1.0/levels#build-l2)
[![MCP](https://img.shields.io/badge/MCP-1.29-8A2BE2.svg)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)

**[⚡ 30초 설치](#-빠른-시작) · [🏆 #1인 이유](#why-number-one) · [🧠 사용 사례](#-사용-사례) · [📊 벤치마크](./docs/benchmarks.md) · [📖 API 레퍼런스](https://oomkapwn.github.io/enquire-mcp/api/)**

**Claude Code — 한 줄로:**

```bash
claude mcp add obsidian -- npx -y @oomkapwn/enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
```

</div>

> 📌 이 문서는 [README.md](./README.md)의 한국어 번역으로, 한국어 사용자의 가독성을 돕기 위한 것입니다. 내용이 다를 경우 **영어 버전이 기준**이 됩니다(영어 버전은 매 릴리스마다 업데이트됩니다).

---

## 문제

모든 AI 세션은 처음부터 시작합니다. 프로젝트, 설계 결정, 이전 연구의 결론을 매번 다시 설명합니다. 벤더 내장 메모리는 지식을 하나의 클라우드에 가두고 도구를 바꾸면 연속성을 잃습니다. **당신의 지식은 계속해서 처음부터 다시 시작합니다.**

## 해결책

당신의 Obsidian Vault는 모든 MCP 호환 에이전트를 위한 **영속적이고 질의 가능한 장기 기억**이 됩니다. 한 번의 설치로 — 당신의 지식은 Claude Code, Claude Desktop, Cursor, ChatGPT 커스텀 GPT, Codex, OpenClaw, 그리고 다른 모든 MCP 클라이언트에서 즉시 접근 가능해집니다. **당신이 소유하는** 일반 마크다운 파일을 로컬에서 인덱싱하고, 완전한 최신 IR 스택으로 검색하며, 모든 세션과 모든 모델에 걸쳐 불러옵니다.

**추출된 요약이 아니라 당신이 쓴 원문에 근거합니다.** 대부분의 대화 메모리 시스템은 채팅에서 사실을 별도 저장소로 추출합니다. enquire-mcp는 당신이 의도적으로 기록한 지식에서 시작합니다. 원본 `.md`와 인용이 남아 회상을 감사하고 편집하고 이동할 수 있으며, 타인의 데이터베이스에 숨은 손실성 의역이 되지 않습니다. 로컬 우선 Vault가 계속 source of truth이고 serve 중 cloud call은 0입니다.

**근거 기반 — 그리고 신선도를 인식합니다.** 사실을 회상하는 것은 문제의 절반일 뿐입니다. 그것이 여전히 *참*인지 아는 것이 나머지 절반입니다. [Memora 벤치마크](https://arxiv.org/abs/2604.20006)(2026년 4월)는 기억 시스템이 오래된 사실의 재사용에서 체계적으로 실패함을 보여주었습니다 — 1년 된 노트를 마치 오늘 작성된 것처럼 회상하는 것입니다. enquire의 기억은 당신의 실제 마크다운 파일 *그 자체*이기 때문에, 모든 검색 결과는 노트의 실시간 마지막 수정 시각에서 파생된 `age_days` + `stale` 플래그를 담고 있으며, 더 신선한 노트가 먼저 떠오르도록 최신성 가중 순위(`--recency-weight`)를 선택적으로 켤 수 있습니다. 당신의 지식, 신선도를 인식하는 — 시간을 초월한 덩어리가 아닙니다.

> **무엇이 enquire-mcp를 다르게 만드는가**:
> 1. **벤더 중립.** 당신의 기억은 `.md` 파일에 존재합니다. Claude에서 Cursor로 전환해도 — 당신의 기억이 함께 따라옵니다.
> 2. **완전한 로컬 검색 스택.** BM25 + TF-IDF + 다국어 임베딩을 RRF로 융합하고 선택형 BGE 크로스 인코더 리랭커와 신호별 점수를 제공합니다. HNSW + int8 양자화가 dense path를 확장합니다.
> 3. **serve 중 클라우드 호출 0건.** 임베딩 모델은 **당신의 머신에서** 실행되어 **당신이** 작성한 마크다운을 인덱싱합니다 — 그래서 클라우드 API 키가 아니라 일회성 로컬 다운로드(~110 MB)입니다. 근거 기반 + 프라이버시는 공짜가 아니며, 우리는 그런 척하지 않습니다. 당신의 Vault 콘텐츠는 당신의 머신을 결코 떠나지 않으며, 기본적으로 에어갭(air-gap) 안전합니다([강제됨](./SECURITY.md), 희망 사항이 아님).
> 4. **신선도를 인식하는 회상.** 모든 결과는 노트가 얼마나 오래되었는지 보고합니다. 선택형 최신성 재순위는 에이전트가 신선한 지식을 선호하고 재검증이 필요한 오래된 사실을 표시하도록 합니다 — 망각을 인식하는 최전선이, 당신의 파일이 이미 가진 `mtime` 위에 구축됩니다.

**도구 46개 · MCP 프롬프트 19개 · 단위 테스트 1720+개 · 50+ 개 언어 · v3.11.x stable · semver 결속 · MIT · npm 빌드 출처 증명(SLSA L2).**

---

<a id="why-number-one"></a>

## 🏆 enquire-mcp가 #1인 이유

**Obsidian을 위한 완전한 로컬 AI 메모리 스택—얇은 파일 래퍼도, 단순한 벡터 검색도 아닙니다.** 한 번의 설치로 검색 품질, 지식 소유권, 에이전트 범위, 문서 지원, 프로덕션 운영을 모두 갖춥니다.

| 리더십 기준 | enquire-mcp가 제공하는 것 |
|---|---|
| **정확한 단어를 넘어서는 회상** | ✅ BM25 + TF-IDF + 다국어 임베딩 → RRF 융합; 선택형 BGE 리랭킹의 실측 향상 **+15.5 NDCG@10 / +24.7 MRR** |
| **모든 에이전트에 하나의 메모리** | ✅ Claude Code/Desktop, Cursor, ChatGPT, Codex, OpenClaw 및 모든 호환 클라이언트에 MCP-native access |
| **검증 가능한 답변** | ✅ 원문, 노트 경로, PDF 페이지 인용, 신호별 점수, freshness metadata |
| **실제로 소유하는 지식** | ✅ plain markdown이 source of truth, 인덱스는 로컬, serve 중 cloud call 0 |
| **Obsidian 지식 표면 전체** | ✅ Markdown, wikilink, frontmatter, Canvas, Bases, PDF, OCR |
| **어려운 질문을 위한 agentic retrieval** | ✅ HyDE, sub-question decomposition, context packs, GraphRAG-light, 19 workflow prompts |
| **통제권을 잃지 않는 확장성** | ✅ HNSW live update, persistence, adaptive refill, int8 quantization |
| **프로덕션 신뢰** | ✅ 기본 read-only, privacy filter, 인증 HTTP, semver contracts, 1720 tests, 9 release gates, SLSA L2 provenance |

**하나의 Vault. 모든 에이전트. 완전한 검색 스택. 클라우드 종속 없음.**

> 전략적 포지셔닝: enquire-mcp는 기존 Obsidian Vault 위에 구축하는 [Karpathy식 LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)의 오픈소스 백엔드입니다. 지식은 축적되고 항상 출처로 추적됩니다.

---

## ⚡ 빠른 시작

```bash
npm install -g @oomkapwn/enquire-mcp
enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
```

아무 MCP 클라이언트에나 연결하세요:

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

📂 바로 사용 가능한 설정이 [`examples/`](./examples/)에 있습니다 — **Claude Desktop**, **Cursor**, **ChatGPT 커스텀 GPT**(HTTP 기반 원격 MCP), 그리고 평가 하니스를 위한 샘플 쿼리 세트.

**완전한 하이브리드 성능을 원하시나요?** 하이브리드 사전 점검을 마친 뒤 서버를 시작하세요:

```bash
npm install -g @oomkapwn/enquire-mcp@3.12.0-rc.18      # exact prerelease package
enquire-mcp --version
# recommended: preview first, then explicitly apply the same package-coherent plan
enquire-mcp first-run --tier hybrid --client claude-desktop --vault <path>
enquire-mcp first-run --tier hybrid --client claude-desktop --vault <path> --apply
# manual equivalent below: choose this instead of first-run --apply, not in addition
enquire-mcp setup --vault <path>                          # embedder 캐시, FTS5 + 임베딩 DB 구축
enquire-mcp install-model rerank-bge                      # 오프라인 reranker 캐시
enquire-mcp doctor --tier hybrid --vault <path>           # 구조/runtime 준비 상태
enquire-mcp configure --tier hybrid --client claude-desktop --vault <path>
enquire-mcp serve --vault <path> --persistent-index --enable-reranker --use-hnsw
```

---

## 🤖 AI 에이전트에서 설정하기 — 복사-붙여넣기 프롬프트

`enquire-mcp`를 설치한 뒤, Vault가 기억으로 사용 가능하다는 것을 에이전트가 알도록 다음 프롬프트를 붙여넣으세요.

<details>
<summary><b>Claude Code (터미널)</b> — MCP 서버 추가 + 첫 프롬프트</summary>

```bash
# Claude Code 설정에 MCP 서버 추가 (1회)
claude mcp add obsidian -- npx -y @oomkapwn/enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
```

그런 다음 아무 Claude Code 세션에서:

> 이제 너는 내 Obsidian Vault를 검색하고 읽는 `obsidian_*` 도구들을 가지고 있어 — 이것이 내 장기 기억이야. 프로젝트, 결정, 사람, 기술적 맥락에 관한 질문에 답하기 전에 관련 용어로 `obsidian_search`를 호출해. 각 사실은 출처 노트와 함께 인용하고(PDF는 `[page: N]`도). 관련 노트를 찾지 못하면 그렇다고 말해 — 추측하지 마.

</details>

<details>
<summary><b>Claude Desktop</b> — 설정 파일 + 첫 프롬프트</summary>

바로 붙여 넣을 수 있는 `enquire-mcp configure --tier hybrid --client claude-desktop --vault <path>` 출력을 권장합니다. [`examples/claude-desktop-hybrid.json`](./examples/claude-desktop-hybrid.json)은 템플릿일 뿐이며, 수동으로 사용할 때는 실행 파일과 Vault 경로를 모두 바꾸세요. Claude Desktop을 재시작한 뒤:

> 너는 `obsidian_*` 도구들을 통해 내 Obsidian Vault를 검색 가능한 기억으로 연결해 두었어. 내 노트에 있는 무엇이든 — 회의 맥락, 리서치, 결정, 일지 항목 — 물어볼 때면 항상 먼저 `obsidian_search`를 확인해. 모든 사실에 출처 노트 경로를 인용해.

</details>

<details>
<summary><b>Cursor</b> — MCP stdio 설정 + 에이전트 규칙</summary>

[`examples/cursor-mcp.json`](./examples/cursor-mcp.json)을 `~/.cursor/mcp.json`에 넣으세요(Vault 경로 수정). `.cursorrules` 파일이나 채팅에서:

> 내가 노트를 가지고 있을 법한 주제(아키텍처 결정, API 계약, 벤더 평가)와 관련된 코드를 제안하기 전에, 먼저 `obsidian_search`를 호출해. 내 Obsidian Vault를 권위 있는 컨텍스트로 취급해.

</details>

<details>
<summary><b>ChatGPT 커스텀 GPT</b> — HTTP 기반 원격 MCP</summary>

[`examples/chatgpt-actions.md`](./examples/chatgpt-actions.md)을 따라 bearer 인증과 함께 터널을 통해 `serve-http`를 노출하세요. 커스텀 GPT의 지침에:

> 너는 `obsidian_*` 도구 패밀리를 통해 내 Obsidian Vault에 읽기 접근 권한이 있어. 내 노트에 있을 법한 것을 답하기 전에 검색해. 모든 주장에 출처 파일 경로를 인용해.

</details>

<details>
<summary><b>OpenClaw / Codex / 그 외 모든 MCP 클라이언트</b></summary>

동일한 `npx -y @oomkapwn/enquire-mcp serve --vault <path>` 명령이 모든 MCP 호환 클라이언트에서 작동합니다. 서버 항목을 어디에 넣을지는 해당 클라이언트의 MCP 설정 문서를 참고한 뒤, 위 프롬프트 중 아무거나 사용하세요.

</details>

**재사용 가능한 에이전트 규칙** (에이전트가 *언제* Vault에 손을 뻗어야 하는지 알도록 아무 `AGENTS.md` / `CLAUDE.md` / `.cursorrules`에 넣으세요):

> 내 질문이 내 노트, 결정, 프로젝트, 사람, 리서치에 관련될 때면, `obsidian_*` 도구(우선 `obsidian_search`)로 **먼저 내 Obsidian Vault를 검색**하고 모든 사실에 출처 노트를 인용해. *개념적 / 언어 간 / "내가 X에 대해 뭐라고 했더라"* 식의 회상에는 enquire를 선호하고, 정확한 리터럴 문자열에는 일반 `grep` / `ripgrep`을 사용해. 관련된 것이 아무것도 나오지 않으면 그렇다고 말해 — 추측하지 마.

### 잘 작동하는 예시 쿼리

- *"내가 가격 전략을 논한 모든 노트를 찾아서 그 변화를 요약해줘."* — RRF 융합 + 리랭커가 "변화"를 의미적으로 처리합니다
- *"PostgreSQL 대 MongoDB에 대한 내 결정이 뭐였지? 데일리 노트를 인용해."* — 위키링크 그래프 부스트가 핵심 결정 문서를 떠오르게 합니다
- *"Анализируй мои заметки о RAG за последние 3 месяца"* — 다국어 임베딩 + frontmatter 날짜 필터
- *"LLaMA-3 논문 PDF의 어떤 페이지가 스케일링을 다루지?"* — `[page: N]` 인용과 함께 검색에 융합된 PDF
- *"내 리서치 Vault의 주제별 커뮤니티를 보여줘 — 내가 어떤 테마를 탐구해왔지?"* — `obsidian_get_communities` (GraphRAG-light)

---

## 🧠 사용 사례

**1 — AI 에이전트를 위한 장기 기억.** 당신의 Obsidian Vault를 아무 MCP 호환 에이전트(Claude Code, Claude Desktop, Cursor, ChatGPT, Codex, OpenClaw)에 넣으세요. 이제 에이전트는 당신이 작성한 모든 회의 노트, 일지 항목, 리서치 로그, 결정 문서에 대해 — 세션, 모델, 공급자를 가로질러 — 영속적이고 시맨틱한 회상을 갖습니다. 벤더 내장 메모리와 달리, 당신의 지식은 한 벤더의 클라우드에 갇히지 않습니다. 그것은 당신이 소유하고 자유롭게 이전할 수 있는 일반 마크다운에 존재합니다.

**2 — 개인 지식 베이스 / 두 번째 뇌.** 하이브리드 검색은 50+ 개 언어 중 어느 언어로든, *어떤* 표현에 대해서도 올바른 노트를 떠오르게 합니다. 2년 전의 러시아어 일지 항목에 대해 영어로 물어도 올바른 결과를 얻습니다. 위키링크 그래프 부스트는 당신의 지식 그래프 중심에 있는 노트를 재순위합니다. GraphRAG-light는 주제별 커뮤니티를 떠오르게 합니다 — 당신이 만든 줄 잊고 있던 연결을 발견하세요. PDF는 `[page: N]` 인용과 함께 검색에 융합되어, 리서치 논문과 회의 녹취록이 일등급 기억이 됩니다.

**3 — 에이전트형 RAG / 컨텍스트 엔지니어링.** `obsidian_search`는 신호별 점수를 노출해, 에이전트가 각 결과가 *왜* 순위에 올랐는지 볼 수 있습니다. HyDE는 검색 전에 모호한 쿼리를 풍부한 가설적 답변으로 미리 재작성합니다. 하위 질문 분해는 멀티홉 질문("우리 가격 전략이 어떻게 변했고 고객 반응은 어땠지?")을 독립적인 하위 쿼리로 쪼개고 결과를 융합해 처리합니다. 내장 평가 하니스(NDCG / Recall / MRR)는 벤더 벤치마크를 신뢰하는 대신 당신 자신의 쿼리로 검색 품질을 측정하게 해줍니다.

---

## ✅ 진지한 로컬 지식 워크플로를 위해 설계

다음을 원한다면 enquire-mcp를 선택하세요:

- **Obsidian Vault를 source of truth로 유지**하고 지식을 독점 저장소에 복사하지 않기.
- **여러 AI 에이전트가 하나의 메모리를 공유**해 모델을 바꿔도 다시 시작하지 않기.
- **표현이 달라도 찾는 개념적·다국어 회상**.
- **노트 경로, PDF 페이지, 신호 점수, freshness가 있는 인용·검사 가능한 결과**.
- **로컬 우선 개인정보 보호**—기본 read-only, 명시적 쓰기, serve 중 cloud call 0.
- **완전한 검색 백엔드**—하이브리드 검색, 리랭킹, 그래프 문맥, agentic expansion, Obsidian 형식, remote MCP.

**명확한 범위:** enquire-mcp는 Markdown, Canvas, Bases, PDF용 headless MCP server / CLI입니다. 정확한 토큰에는 literal search를 함께 쓰고, 원격 에이전트에는 내장 HTTP transport를 사용하세요.

---

## 📖 API 레퍼런스

자동 생성된 **[oomkapwn.github.io/enquire-mcp의 API 레퍼런스](https://oomkapwn.github.io/enquire-mcp/api/)** — 모든 도구, 프롬프트, 내보낸 헬퍼를 완전한 TSDoc(`@param` / `@returns` / `@example`)과 함께 제공합니다. [`publish-docs.yml`](https://github.com/oomkapwn/enquire-mcp/blob/main/.github/workflows/publish-docs.yml)을 통해 `main`에 푸시될 때마다 소스에서 재빌드됩니다(TypeDoc → GitHub Pages). 구조적으로 드리프트가 없습니다: AI 에이전트와 IDE가 보는 바로 그 TSDoc이 게시되는 것입니다.

---

## 🏗️ 검색 동작 방식

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

`obsidian_search`는 사용 가능한 신호를 자동 감지하고 우아하게 성능을 낮춥니다. 위키링크 그래프 부스트는 1-스텝 개인화 PageRank로 top-K를 재순위합니다. 선택형 크로스 인코더 리랭킹은 측정된 +15.5 NDCG@10을 위해 top-N을 재채점합니다. 모든 결과는 `per_signal: { bm25, tfidf, embeddings }`를 반환해, 왜 그 순위에 올랐는지 볼 수 있습니다.

| 등급 | 설정 | 얻는 것 |
|---|---|---|
| **1** | `serve --vault <path>` | TF-IDF 코사인 (설정 0, 즉시) |
| **2** | + `--persistent-index` | + BM25 / FTS5 (인덱스 기반 어휘 검색) |
| **3** | + `setup` (모델 다운로드 + 임베딩 DB 구축) | + 다국어 ML 임베딩 |
| **4** | + `--enable-reranker` | + BGE 크로스 인코더 (측정된 +15.5 NDCG@10) |
| **5** | + `--use-hnsw` | + 영속 HNSW를 이용한 근사 최근접 이웃 검색 |
| **6** | + `--include-pdfs` | + 위의 모든 것에 융합된 PDF |
| **7** | `serve-http --bearer-token …` | + 원격 MCP (Claude.ai 웹, ChatGPT, Cursor HTTP, 모바일) |

---

## 🛠️ 전체 46개 도구

총 46개 도구: 상시 활성 읽기 34개(우산 격인 `obsidian_search` 포함) + 선택형 읽기 4개 + 게이트된 쓰기 7개 + 폐루프 피드백 1개. 전체 레퍼런스: **[docs/api.md](./docs/api.md)**.

| 범주 | 도구 |
|---|---|
| **검색 & 회수** | `obsidian_search` (우산, RRF 융합) · `obsidian_hyde_search` (HyDE 증강, v3.1.0) · `obsidian_search_text` · `obsidian_full_text_search` · `obsidian_semantic_search` · `obsidian_embeddings_search` · `obsidian_find_similar` |
| **위키링크 & 그래프** | `obsidian_resolve_wikilink` · `obsidian_get_backlinks` · `obsidian_get_outbound_links` · `obsidian_get_note_neighbors` · `obsidian_get_unresolved_wikilinks` · `obsidian_find_path` · `obsidian_get_communities` (v3.4.0, GraphRAG-light) |
| **Frontmatter & Dataview** | `obsidian_frontmatter_get` · `obsidian_frontmatter_search` · `obsidian_dataview_query` · `obsidian_list_tags` |
| **읽기 & 탐색** | `obsidian_read_note` · `obsidian_list_notes` · `obsidian_get_recent_edits` · `obsidian_stale_notes` · `obsidian_open_questions` · `obsidian_context_pack` · `obsidian_chat_thread_read` · `obsidian_open_in_ui` · `obsidian_stats` |
| **PDF, Canvas & Bases** | `obsidian_read_pdf` · `obsidian_list_pdfs` · `obsidian_ocr_pdf` · `obsidian_read_canvas` · `obsidian_list_canvases` · `obsidian_list_bases` (v3.2.0) · `obsidian_read_base` (v3.2.0) · `obsidian_query_base` (v3.2.0) |
| **쓰기** (`--enable-write`로 게이트) | `obsidian_create_note` · `obsidian_append_to_note` · `obsidian_rename_note` · `obsidian_replace_in_notes` · `obsidian_archive_note` · `obsidian_frontmatter_set` · `obsidian_chat_thread_append` |
| **진단 / 린트** | `obsidian_lint_wiki` · `obsidian_paper_audit` · `obsidian_validate_note_proposal` |
| **피드백** (`--feedback-weight`로 선택 활성) | `obsidian_mark_useful` (폐루프: 회상된 노트 중 어느 것이 도움이 되었는지 기록; 향후 검색에서 가중) |

추가로 3개의 MCP 리소스(`obsidian://vault/info`, `obsidian://note/{path}`, `obsidian://chunk/{n}/{path}`)와 일반적인 Vault 워크플로를 위한 19개의 **MCP 프롬프트**(`summarize_recent_edits` · `review_tag` · `find_orphans` · `weekly_review` · `extract_todos` · `process_inbox` · `consolidate_tags` · `find_duplicates` · `lint_wiki` · `monthly_review` · `search_with_query_expansion` · `vault_synth` · `vault_wiki_compile` · `vault_lint_extended` · `vault_capture` · `vault_persona_search` · `vault_automation_setup` · `vault_research` · `vault_synthesis_page`)가 있습니다.

---

## 🛡️ 신뢰

| 표면 | 자세(Posture) |
|---|---|
| **기본값** | 읽기 전용 — 7개 쓰기 도구에는 `--enable-write` 필요 |
| **최소 권한** | `--disabled-tools` / `--enabled-tools`로 최소 표면 노출 (예: 읽기 전용 리서치 에이전트는 `obsidian_search` + `obsidian_read_note`만 받음) |
| **경로 안전성** | 모든 읽기+쓰기에서 realpath 검증; Vault 밖으로 나가는 심볼릭 링크 거부 |
| **프라이버시 필터** | FTS5 + 임베딩 DB + 청크 리소스 경로에서 검증; 빈 허용/거부 목록에 대해 fail-closed |
| **HTTP 전송** | Bearer 인증 (상수 시간 SHA-256 + `timingSafeEqual`), 토큰별 속도 제한, 엄격한 CORS |
| **Frontmatter** | `js-yaml@5` `load` (YAML 1.2 코어 스키마, 기본 안전) — 코드 실행 없음 |
| **캐시 + 인덱스 파일** | chmod 0600, 부모 디렉터리 0700 |
| **단위 테스트 1720개 · 릴리스 필수 CI 검사 9개 · 현재 브랜치 보호 7개** | 현재 검증된 릴리스 상태이며 운영 세부사항은 아래에 고정되어 있습니다. |
| **CI** | 모든 PR에서 **릴리스 필수 검사 9개**(`lint`, `test (22)`, `test (24)`, `smoke`, `audit`, `coverage`, `version-consistency`, `docs`, `oia`)를 실행합니다. 현재 브랜치 보호가 강제하는 것은 **7개**뿐이며, `docs`와 `oia`는 릴리스 필수지만 보호되지 않습니다(2026-07-23 실시간 확인). `test-macos`는 `continue-on-error`가 있는 유일한 권고 job입니다. `docker`는 CI workflow를 실패시킬 수 있지만 보호되지 않으며, CodeQL은 [GitHub default setup](https://docs.github.com/code-security/code-scanning/automatically-scanning-your-code-for-vulnerabilities-and-errors/configuring-default-setup-for-code-scanning)을 통해 별도의 미보호 분석 2개를 실행합니다. npm publish 전에 `release.yml`이 태깅된 SHA에서 9개 모두를 다시 확인합니다. |
| **커버리지** | 라인 ≥86% · 구문 ≥82% · 함수 ≥75% · 브랜치 ≥74% (게이트됨) |
| **릴리스** | 태그별 npm + GitHub 릴리스 · semver · **서명된 빌드 출처 증명** (npm + Sigstore, SLSA Build L2; L3 생성기는 로드맵에) |
| **안정성** | v3.0+ semver 결속 — 모든 CLI 플래그, 도구 이름, MCP 리소스, 프롬프트, 내보낸 심볼이 계약입니다 |

전체 자세: **[SECURITY.md](./SECURITY.md)** · 안정성 표면: **[STABILITY.md](./STABILITY.md)** · 취약점: `oomkapwn@gmail.com`.

---

## ❓ FAQ

**Obsidian 설치가 필요한가요?** 아니요. `.md` + `.canvas` + `.pdf`를 직접 읽습니다. 모든 Obsidian 포맷 Vault에서 작동합니다.

**내 Vault에 쓰기를 하나요?** `--enable-write`를 전달하지 않는 한 안 합니다. 7개 쓰기 도구는 모두 게이트되어 있으며, 파괴적인 것들은 `dry_run`을 지원합니다.

**데이터가 어딘가로 전송되나요?** 외부 다운로드는 명시적 획득 명령에서만 발생합니다. `enquire-mcp setup`, `enquire-mcp build-embeddings`, `enquire-mcp install-model`은 HuggingFace의 ONNX 가중치를 받을 수 있고, `enquire-mcp install-ocr-lang`은 OCR용 Tesseract 언어 팩을 받습니다. serve 모드는 절대 외부로 나가는 HTTP를 만들지 않습니다. 임베딩 + 리랭커는 로컬 CPU에서 실행됩니다.

**성능은요?** Vault 크기, 하드웨어, 모델, 활성 검색 계층에 따라 달라집니다. 공개 근거에는 1,771 chunks / 368 files에서 BM25 top-10이 **50–100ms**였다는 운영 보고와 100–1,000 notes에서 FTS5가 선형 스캔보다 **37–103×** 빨랐다는 재현 가능한 합성 벤치마크가 포함됩니다. 지연 시간 SLO를 정하기 전에 자신의 Vault에서 내장 평가를 실행하세요.

**언어는요?** 기본 embedder는 `paraphrase-multilingual-MiniLM-L12-v2`(50+개 언어)이며 러시아어 + 영어 이중 언어 Vault에서 엔드 투 엔드 검증되었습니다. 기본 cross-encoder reranker는 `rerank-bge`(English-only; 엔드 투 엔드 검증된 유일한 catalog alias)입니다. 다국어 reranker alias는 현재 transformers.js tokenizer 호환성 검사에 실패합니다. CJK/태국어/크메르어 토큰화에는 `Intl.Segmenter`를 사용합니다.

**원격 실행이 되나요?** 예 — `serve-http`는 [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http)를 통해 동일한 서버를 노출합니다. HTTPS를 위해 앞단에 Tailscale Funnel이나 Cloudflare Tunnel을 두세요. claude.ai 웹, ChatGPT 커스텀 GPT, Cursor HTTP 모드, 모바일 MCP 클라이언트에서 작동합니다. **[docs/http-transport.md](./docs/http-transport.md)**를 보세요.

---

## 🚀 릴리스

**v3.0.0 — stable 채널.** v2.x 검색 로드맵이 완성되었고 공개 표면은 이제 [semver로 결속](./STABILITY.md)되었습니다. 하이라이트 모음:

`v2.0` 하이브리드 검색 (BM25+TF-IDF+임베딩 via RRF) · `v2.6` 원격 MCP · `v2.7-2.8` PDF 융합 · `v2.9` BGE 리랭커 · `v2.10` OCR · `v2.11` doctor + setup · `v2.12` 평가 하니스 · `v2.13` HNSW · `v2.14` 상태 유지 세션 · `v2.15` late-chunking · `v2.16` HNSW 영속화 · `v2.17` int8 양자화 · `v3.8.0` stable · `v3.8.7` HTTP 전송 강화 · **`v3.9.0` stable**: OCR된 PDF 워처 임베딩 동기화, 파일 변경 시 HNSW 인메모리 실시간 업데이트, R-10 적응형 HNSW 리필(>66% 제외 시의 과소 반환 문제 해결). · **`v3.10` stable**: 망각을 인식하는 신선도 — `age_days` + `stale` 플래그 + 선택형 `--recency-weight` 재순위 + frontmatter를 인식하는 `obsidian_search`.

채널: `npm install @oomkapwn/enquire-mcp` → 최신 stable (`@latest` = v3.11.x). 사전 릴리스: `npm install @oomkapwn/enquire-mcp@rc` (최신 릴리스 후보 — [CHANGELOG.md](./CHANGELOG.md) 참조). 전체 변경 로그: **[CHANGELOG.md](./CHANGELOG.md)** · 향후 계획: **[ROADMAP.md](https://github.com/oomkapwn/enquire-mcp/blob/main/ROADMAP.md)**.

---

## 🤝 기여하기

```bash
git clone https://github.com/oomkapwn/enquire-mcp.git
cd enquire-mcp && npm install
npm test       # 전체 스위트 (1720개 테스트)
npm run lint   # 경고 0건
npm run build  # tsc → dist/
```

이슈, PR, 아이디어를 환영합니다.

---

## 📜 라이선스

MIT. [Alex (@OomkaBear)](https://github.com/oomkapwn)가 만들었습니다. [Tim Berners-Lee의 1980년 WWW 프로토타입](https://en.wikipedia.org/wiki/ENQUIRE)의 이름을 땄습니다 — 웹 이전의, 최초의 하이퍼텍스트 시스템. 원래 사양은 이랬습니다: 당신은 시스템에 무엇이든 물어볼 수 있다. **enquire-mcp는 그것을 당신의 Vault로 가져옵니다.**
