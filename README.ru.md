<div align="center">

<a href="https://github.com/oomkapwn/enquire-mcp"><img src="./assets/social-preview.png" alt="enquire-mcp — Obsidian MCP №1 для памяти AI-агентов." width="100%"></a>

# enquire-mcp

<sub>[English](./README.md) · [中文](./README.zh.md) · [Español](./README.es.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md) · **Русский** · [Português](./README.pt.md) · [Français](./README.fr.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Deutsch](./README.de.md)</sub>

<sub>**TL;DR для AI-агентов** — MCP-сервер, открывающий локальное Obsidian-хранилище из markdown-файлов для Claude Code, Claude Desktop, Cursor, ChatGPT, Codex и OpenClaw как постоянную поисковую память. Гибридный поиск (BM25 + ML-эмбеддинги + BGE-реранкер, объединённые через RRF), HNSW + int8-квантизация, агентный RAG (HyDE + декомпозиция на подвопросы), GraphRAG-light, PDF + OCR, автономные Bases. Нейтральность к вендору, MIT, ноль обращений в облако в режиме serve. Установка: `npm i -g @oomkapwn/enquire-mcp`. Документация: [llms.txt](https://github.com/oomkapwn/enquire-mcp/blob/main/llms.txt) · [AGENTS.md](https://github.com/oomkapwn/enquire-mcp/blob/main/AGENTS.md) · [API](https://oomkapwn.github.io/enquire-mcp/).</sub>

### 🏆 Obsidian MCP №1 для памяти AI-агентов.

**Хватит заново объяснять контекст Claude, Cursor, ChatGPT, Codex, OpenClaw в каждой сессии. Ваши заметки Obsidian становятся общей поисковой памятью для всех MCP-совместимых агентов — ваши знания, любая модель, навсегда ваши.**

[![CI](https://github.com/oomkapwn/enquire-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/oomkapwn/enquire-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@oomkapwn/enquire-mcp.svg?label=npm&color=cb3837)](https://www.npmjs.com/package/@oomkapwn/enquire-mcp)
[![downloads](https://img.shields.io/npm/dm/@oomkapwn/enquire-mcp.svg?color=cb3837)](https://www.npmjs.com/package/@oomkapwn/enquire-mcp)
[![tests](https://img.shields.io/badge/tests-1710%20passing-brightgreen.svg)](#️-доверие)
[![stable](https://img.shields.io/badge/v3.11.x-stable-brightgreen.svg)](./STABILITY.md)
[![build provenance](https://img.shields.io/badge/build_provenance-SLSA_L2-blue.svg)](https://slsa.dev/spec/v1.0/levels#build-l2)
[![MCP](https://img.shields.io/badge/MCP-1.29-8A2BE2.svg)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)

**[⚡ Установка за 30 секунд](#-быстрый-старт) · [🏆 Почему №1](#why-number-one) · [🧠 Сценарии использования](#-сценарии-использования) · [📊 Бенчмарки](./docs/benchmarks.md) · [📖 Справочник API](https://oomkapwn.github.io/enquire-mcp/)**

**Claude Code — одна строка:**

```bash
claude mcp add obsidian -- npx -y @oomkapwn/enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
```

</div>

> 📌 Этот документ — перевод [README.md](./README.md) на русский язык, для удобства русскоязычных читателей; при любых расхождениях **приоритет имеет английская версия** (она обновляется с каждым релизом).

---

## Проблема

Каждая AI-сессия начинается с нуля. Вы снова объясняете проект, архитектурные решения и выводы прошлого исследования. Встроенная память вендора запирает знания в одном облаке и рвёт непрерывность при смене инструмента. **Ваши знания постоянно начинаются заново.**

## Решение

Ваше хранилище Obsidian становится **постоянной, доступной для запросов долговременной памятью** для любого MCP-совместимого агента. Одна установка — и ваши знания мгновенно доступны из Claude Code, Claude Desktop, Cursor, кастомного GPT в ChatGPT, Codex, OpenClaw и любого другого MCP-клиента. Обычные markdown-файлы, **которыми владеете вы**, индексируются локально, ищутся с помощью полного современного IR-стека и вспоминаются в каждой сессии и с каждой моделью.

**Опирается на оригинал, а не на извлечённый пересказ.** Большинство систем памяти диалогов извлекает факты из чатов в отдельное хранилище. enquire-mcp начинает со знаний, которые вы осознанно записали: исходные `.md`-заметки и ссылки на них сохраняются дословно, поэтому память можно проверить, отредактировать и перенести. Это не скрытый в чужой базе данных пересказ с потерями. Локальное хранилище остаётся источником истины, а в режиме serve облачных вызовов нет.

**Опора на ваш текст — и с учётом свежести.** Вспомнить факт — это лишь половина задачи; знать, *верен* ли он до сих пор, — вторая половина. [Бенчмарк Memora](https://arxiv.org/abs/2604.20006) (апрель 2026) показал, что системы памяти систематически проваливаются на повторном использовании устаревших фактов — вспоминают годовалую заметку так, будто она написана сегодня. Поскольку память enquire — это *и есть* ваши настоящие markdown-файлы, каждый найденный результат несёт `age_days` + флаг `stale`, выведенные из реального времени последнего изменения заметки, и вы можете включить ранжирование с учётом давности (`--recency-weight`), чтобы более свежие заметки всплывали первыми. Ваши знания с учётом свежести — а не вневременной ком.

> **Что отличает enquire-mcp**:
> 1. **Нейтральность к вендору.** Ваша память живёт в `.md`-файлах. Переключитесь с Claude на Cursor — ваша память переезжает с вами.
> 2. **Полный локальный retrieval-стек.** BM25 + TF-IDF + мультиязычные эмбеддинги объединяются через RRF, опциональный BGE-реранкер добавляет оценки по каждому сигналу, а HNSW + int8-квантизация масштабируют dense-путь.
> 3. **Ноль обращений в облако в режиме serve.** Модели кешируются локально (однократная загрузка с HuggingFace). Содержимое вашего хранилища никогда не покидает вашу машину. По умолчанию безопасно для изолированных сред.
> 4. **Поиск с учётом свежести.** Каждый результат сообщает, насколько стара заметка; опциональное переранжирование по давности позволяет агенту предпочитать свежие знания и помечать устаревшие факты для повторной проверки — рубеж «осознания забывания», построенный на `mtime`, который ваши файлы уже имеют.

**46 инструментов · 19 MCP-промптов · 1710+ модульных тестов · 50+ языков · стабильная ветка v3.11.x · с гарантиями semver · MIT · подтверждённая сборка в npm (SLSA L2).**

---

<a id="why-number-one"></a>

## 🏆 Почему enquire-mcp — №1

**Полный локальный стек AI-памяти для Obsidian — не тонкая обёртка над файлами и не просто векторный поиск.** Одна установка объединяет качество поиска, владение знаниями, охват агентов и документов, а также эксплуатационную зрелость.

| Стандарт лидерства | Что даёт enquire-mcp |
|---|---|
| **Припоминание вне точного совпадения слов** | ✅ BM25 + TF-IDF + мультиязычные эмбеддинги → RRF; опциональный BGE-реранкер даёт измеренные **+15.5 NDCG@10 / +24.7 MRR** |
| **Одна память для всех агентов** | ✅ MCP-native доступ из Claude Code/Desktop, Cursor, ChatGPT, Codex, OpenClaw и любого совместимого клиента |
| **Проверяемые ответы** | ✅ Дословный текст, пути заметок, страницы PDF, оценки сигналов и метаданные свежести |
| **Знания действительно принадлежат вам** | ✅ Обычный markdown — источник истины; индексы локальны; ноль облачных вызовов в serve |
| **Вся поверхность знаний Obsidian** | ✅ Markdown, wikilinks, frontmatter, Canvas, Bases, PDF и OCR |
| **Агентный поиск для сложных вопросов** | ✅ HyDE, декомпозиция на подвопросы, context packs, GraphRAG-light и 19 workflow-промптов |
| **Масштаб без потери контроля** | ✅ Live-update HNSW, персистентность, адаптивное дозаполнение и int8-квантизация |
| **Продакшен-доверие** | ✅ Read-only по умолчанию, privacy-фильтры, авторизованный HTTP, semver-контракты, 1710 теста, 9 релизных гейтов и SLSA L2 provenance |

**Одно хранилище. Все агенты. Полный стек поиска. Никакого облачного lock-in.**

> Стратегическое позиционирование: enquire-mcp — открытый бэкенд для [LLM Wiki в стиле Карпати](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) поверх уже существующего хранилища Obsidian. Знания накапливаются и всегда прослеживаются до источников.

---

## ⚡ Быстрый старт

```bash
npm install -g @oomkapwn/enquire-mcp
enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
```

Подключите к любому MCP-клиенту:

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

📂 Готовые конфигурации в [`examples/`](./examples/) — **Claude Desktop**, **Cursor**, **кастомный GPT в ChatGPT** (удалённый MCP по HTTP), плюс образец набора запросов для фреймворка оценки.

**Нужна вся мощь гибридного поиска?** Выполните гибридный preflight, затем запускайте сервер:

```bash
npm install -g @oomkapwn/enquire-mcp@3.12.0-rc.11      # exact prerelease package
enquire-mcp --version
# recommended: preview first, then explicitly apply the same package-coherent plan
enquire-mcp first-run --tier hybrid --client claude-desktop --vault <path>
enquire-mcp first-run --tier hybrid --client claude-desktop --vault <path> --apply
# manual equivalent below: choose this instead of first-run --apply, not in addition
enquire-mcp setup --vault <path>                          # кеширует embedder, строит FTS5 + embed-db
enquire-mcp install-model rerank-bge                      # кеширует офлайн-reranker
enquire-mcp doctor --tier hybrid --vault <path>           # структурная/runtime-готовность
enquire-mcp configure --tier hybrid --client claude-desktop --vault <path>
enquire-mcp serve --vault <path> --persistent-index --enable-reranker --use-hnsw
```

---

## 🤖 Настройка в вашем AI-агенте — промпты для копипаста

После установки `enquire-mcp` вставьте эти промпты в вашего агента, чтобы он знал, что хранилище доступно как память.

<details>
<summary><b>Claude Code (терминал)</b> — добавить MCP-сервер + первый промпт</summary>

```bash
# Добавьте MCP-сервер в конфиг Claude Code (однократно)
claude mcp add obsidian -- npx -y @oomkapwn/enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
```

Затем в любой сессии Claude Code:

> Теперь у тебя есть инструменты `obsidian_*`, которые ищут и читают моё хранилище Obsidian — мою долговременную память. Прежде чем отвечать на вопросы о проектах, решениях, людях или техническом контексте, вызывай `obsidian_search` с релевантными терминами. Подкрепляй каждый факт ссылкой на заметку-источник (и `[page: N]` для PDF). Если ты не нашёл релевантную заметку, так и скажи — не угадывай.

</details>

<details>
<summary><b>Claude Desktop</b> — файл конфигурации + первый промпт</summary>

Предпочтителен готовый к вставке вывод `enquire-mcp configure --tier hybrid --client claude-desktop --vault <path>`. [`examples/claude-desktop-hybrid.json`](./examples/claude-desktop-hybrid.json) — только шаблон; при ручном использовании замените и путь к исполняемому файлу, и путь к хранилищу. Перезапустите Claude Desktop, затем:

> У тебя подключено моё хранилище Obsidian как поисковая память через инструменты `obsidian_*`. Всегда сначала проверяй `obsidian_search`, когда я спрашиваю о чём-либо в моих заметках — контекст встреч, исследования, решения, дневниковые записи. На каждом факте цитируй путь к заметке-источнику.

</details>

<details>
<summary><b>Cursor</b> — конфиг MCP stdio + правило агента</summary>

Скопируйте [`examples/cursor-mcp.json`](./examples/cursor-mcp.json) в `~/.cursor/mcp.json` (отредактируйте путь к хранилищу). В вашем файле `.cursorrules` или в чате:

> Прежде чем предлагать код, затрагивающий тему, по которой у меня могут быть заметки (архитектурные решения, API-контракты, оценки вендоров), сначала вызови `obsidian_search`. Считай моё хранилище Obsidian авторитетным контекстом.

</details>

<details>
<summary><b>Кастомный GPT в ChatGPT</b> — удалённый MCP по HTTP</summary>

Следуйте [`examples/chatgpt-actions.md`](./examples/chatgpt-actions.md), чтобы открыть `serve-http` через туннель с bearer-аутентификацией. В инструкциях вашего кастомного GPT:

> У тебя есть доступ на чтение к моему хранилищу Obsidian через семейство инструментов `obsidian_*`. Ищи, прежде чем отвечать на что-либо, что может быть в моих заметках; на каждом утверждении цитируй путь к файлу-источнику.

</details>

<details>
<summary><b>OpenClaw / Codex / любой другой MCP-клиент</b></summary>

Та же команда `npx -y @oomkapwn/enquire-mcp serve --vault <path>` работает для любого MCP-совместимого клиента. Смотрите собственную документацию клиента по конфигурации MCP, чтобы понять, куда поместить запись о сервере, затем используйте любой из промптов выше.

</details>

**Многоразовое правило агента** (вставьте в любой `AGENTS.md` / `CLAUDE.md` / `.cursorrules`, чтобы агент знал, *когда* обращаться к хранилищу):

> Когда мой вопрос затрагивает мои собственные заметки, решения, проекты, людей или исследования, **сначала ищи в моём хранилище Obsidian** через инструменты `obsidian_*` (начни с `obsidian_search`) и цитируй заметку-источник на каждом факте. Предпочитай enquire для *концептуального / кросс-языкового / «что я говорил про X»* припоминания; используй обычный `grep` / `ripgrep` для точных буквальных строк. Если ничего релевантного не вернулось, так и скажи — не угадывай.

### Примеры запросов, которые хорошо работают

- *«Найди каждую заметку, где я обсуждал ценовую стратегию, и обобщи её эволюцию.»* — RRF-объединение + реранкер обрабатывают «эволюцию» семантически
- *«Каким было моё решение по PostgreSQL против MongoDB? Сошлись на дневниковую заметку.»* — усиление по wikilink-графу всплывает центральный документ с решением
- *«Анализируй мои заметки о RAG за последние 3 месяца»* — многоязычные эмбеддинги + фильтр по дате из frontmatter
- *«На каких страницах PDF статьи LLaMA-3 говорится о масштабировании?»* — PDF вплетены в поиск с цитатами `[page: N]`
- *«Покажи тематические сообщества в моём исследовательском хранилище — какие темы я изучал?»* — `obsidian_get_communities` (GraphRAG-light)

---

## 🧠 Сценарии использования

**1 — Долговременная память для AI-агентов.** Подключите ваше хранилище Obsidian к любому MCP-совместимому агенту (Claude Code, Claude Desktop, Cursor, ChatGPT, Codex, OpenClaw). Теперь у агента есть устойчивое семантическое припоминание по каждой заметке о встрече, дневниковой записи, исследовательскому логу и документу с решением, которые вы когда-либо писали — между сессиями, моделями и провайдерами. В отличие от встроенной памяти одного вендора, ваши знания не заперты в облаке одного вендора; они живут в обычном markdown, которым вы владеете и который можете свободно мигрировать.

**2 — Персональная база знаний / второй мозг.** Гибридный поиск всплывает нужную заметку при *любой* формулировке, на любом из 50+ языков. Спросите по-английски о русскоязычной дневниковой записи двухлетней давности — получите правильный результат. Усиление по wikilink-графу переранжирует заметки, находящиеся в центре вашего графа знаний. GraphRAG-light всплывает тематические сообщества — открывайте связи, которые вы забыли, что создавали. PDF вплетаются в поиск с цитатами `[page: N]`, так что научные статьи и расшифровки встреч становятся первоклассной памятью.

**3 — Агентный RAG / контекст-инжиниринг.** `obsidian_search` раскрывает оценки по каждому сигналу, так что агент видит, *почему* каждый результат так ранжирован. HyDE заранее переписывает расплывчатые запросы в богатые гипотетические ответы перед поиском. Декомпозиция на подвопросы обрабатывает многошаговые вопросы («как развивалась наша ценовая стратегия и какой была реакция клиентов?»), разбивая их на независимые подзапросы и объединяя результаты. Встроенный фреймворк оценки (NDCG / Recall / MRR) позволяет измерять качество поиска на ваших собственных запросах, а не доверять вендорским бенчмаркам.

---

## ✅ Создан для серьёзной локальной работы со знаниями

Выбирайте enquire-mcp, если вам нужны:

- **Obsidian как источник истины** без копирования знаний в чужое закрытое хранилище.
- **Единый слой памяти для разных AI-агентов**, чтобы смена модели не означала старт с нуля.
- **Концептуальный и мультиязычный поиск**, устойчивый к другой формулировке запроса.
- **Цитируемые и проверяемые результаты** с путями заметок, страницами PDF, оценками сигналов и свежестью.
- **Local-first приватность** с read-only по умолчанию, явным включением записи и нулём облачных вызовов в serve.
- **Полный retrieval-бэкенд**: гибридный поиск, реранкинг, графовый контекст, агентное расширение, форматы Obsidian и удалённый MCP.

**Чёткие границы:** enquire-mcp — headless MCP-сервер / CLI для Markdown, Canvas, Bases и PDF. Для точных токенов используйте рядом буквальный поиск; для удалённых агентов — встроенный HTTP-транспорт.

---

## 📖 Справочник API

Автогенерируемый **[справочник API на oomkapwn.github.io/enquire-mcp](https://oomkapwn.github.io/enquire-mcp/)** — каждый инструмент, промпт и экспортируемый хелпер с полным TSDoc (`@param` / `@returns` / `@example`). Пересобирается из исходников при каждом push в `main` через [`publish-docs.yml`](https://github.com/oomkapwn/enquire-mcp/blob/main/.github/workflows/publish-docs.yml) (TypeDoc → GitHub Pages). Свободен от рассинхронизации по построению: тот же TSDoc, который видят AI-агенты и IDE, и публикуется.

---

## 🏗️ Как работает поиск

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

`obsidian_search` автоматически определяет доступные сигналы и плавно деградирует. Усиление по wikilink-графу переранжирует top-K через одношаговый персонализированный PageRank. Опциональный кросс-энкодер-реранкинг переоценивает top-N, давая +15.5 NDCG@10 по замерам. Каждый результат возвращает `per_signal: { bm25, tfidf, embeddings }`, так что вы видите, ПОЧЕМУ он так ранжирован.

| Уровень | Настройка | Что вы получаете |
|---|---|---|
| **1** | `serve --vault <path>` | TF-IDF косинус (ноль настройки, мгновенно) |
| **2** | + `--persistent-index` | + BM25 / FTS5 (top-10 за менее чем 100 мс) |
| **3** | + `setup` (загружает модель + строит embed-db) | + многоязычные ML-эмбеддинги |
| **4** | + `--enable-reranker` | + кросс-энкодер BGE (+15.5 NDCG@10 по замерам) |
| **5** | + `--use-hnsw` | + top-K за менее чем 10 мс на масштабе в миллионы чанков |
| **6** | + `--include-pdfs` | + PDF, вплетённые во всё вышеперечисленное |
| **7** | `serve-http --bearer-token …` | + удалённый MCP (веб Claude.ai, ChatGPT, Cursor по HTTP, мобильные) |

---

## 🛠️ Все 46 инструментов

Всего 46 инструментов: 34 всегда включённых на чтение (включая зонтичный `obsidian_search`) + 4 опциональных на чтение + 7 управляемых на запись + 1 инструмент обратной связи с замкнутым контуром. Полный справочник: **[docs/api.md](./docs/api.md)**.

| Категория | Инструменты |
|---|---|
| **Поиск и извлечение** | `obsidian_search` (зонтичный, объединение через RRF) · `obsidian_hyde_search` (с HyDE-аугментацией, v3.1.0) · `obsidian_search_text` · `obsidian_full_text_search` · `obsidian_semantic_search` · `obsidian_embeddings_search` · `obsidian_find_similar` |
| **Wikilink и граф** | `obsidian_resolve_wikilink` · `obsidian_get_backlinks` · `obsidian_get_outbound_links` · `obsidian_get_note_neighbors` · `obsidian_get_unresolved_wikilinks` · `obsidian_find_path` · `obsidian_get_communities` (v3.4.0, GraphRAG-light) |
| **Frontmatter и Dataview** | `obsidian_frontmatter_get` · `obsidian_frontmatter_search` · `obsidian_dataview_query` · `obsidian_list_tags` |
| **Чтение и навигация** | `obsidian_read_note` · `obsidian_list_notes` · `obsidian_get_recent_edits` · `obsidian_stale_notes` · `obsidian_open_questions` · `obsidian_context_pack` · `obsidian_chat_thread_read` · `obsidian_open_in_ui` · `obsidian_stats` |
| **PDF, Canvas и Bases** | `obsidian_read_pdf` · `obsidian_list_pdfs` · `obsidian_ocr_pdf` · `obsidian_read_canvas` · `obsidian_list_canvases` · `obsidian_list_bases` (v3.2.0) · `obsidian_read_base` (v3.2.0) · `obsidian_query_base` (v3.2.0) |
| **Запись** (управляется через `--enable-write`) | `obsidian_create_note` · `obsidian_append_to_note` · `obsidian_rename_note` · `obsidian_replace_in_notes` · `obsidian_archive_note` · `obsidian_frontmatter_set` · `obsidian_chat_thread_append` |
| **Диагностика / линтинг** | `obsidian_lint_wiki` · `obsidian_paper_audit` · `obsidian_validate_note_proposal` |
| **Обратная связь** (опционально через `--feedback-weight`) | `obsidian_mark_useful` (замкнутый контур: фиксирует, какие из вспомненных заметок помогли; усиливает их в будущем поиске) |

Плюс 3 MCP-ресурса (`obsidian://vault/info`, `obsidian://note/{path}`, `obsidian://chunk/{n}/{path}`) и 19 **MCP-промптов** (`summarize_recent_edits` · `review_tag` · `find_orphans` · `weekly_review` · `extract_todos` · `process_inbox` · `consolidate_tags` · `find_duplicates` · `lint_wiki` · `monthly_review` · `search_with_query_expansion` · `vault_synth` · `vault_wiki_compile` · `vault_lint_extended` · `vault_capture` · `vault_persona_search` · `vault_automation_setup` · `vault_research` · `vault_synthesis_page`) для типовых рабочих процессов с хранилищем.

---

## 🛡️ Доверие

| Поверхность | Позиция |
|---|---|
| **По умолчанию** | Только чтение — для 7 инструментов записи требуется `--enable-write` |
| **Минимум привилегий** | `--disabled-tools` / `--enabled-tools` открывают минимальную поверхность (например, исследовательскому агенту только-на-чтение достаются лишь `obsidian_search` + `obsidian_read_note`) |
| **Безопасность путей** | Проверка realpath на каждом чтении+записи; символьные ссылки за пределы хранилища отклоняются |
| **Фильтр приватности** | Проверяется на путях FTS5 + embed-db + chunk-ресурсов; fail-closed при пустых allow-/deny-списках |
| **HTTP-транспорт** | Bearer-аутентификация (SHA-256 с постоянным временем + `timingSafeEqual`), ограничение частоты по токену, строгий CORS |
| **Frontmatter** | `js-yaml@5` `load` (YAML 1.2 core schema, безопасно по умолчанию) — без выполнения кода |
| **Файлы кеша + индекса** | chmod 0600, родительская директория 0700 |
| **1710 модульных тестов · 9 обязательных для релиза CI-проверок · 7 сейчас защищают ветку** | Текущая проверенная релизная позиция; операционная детализация закреплена ниже. |
| **CI** | На каждом PR запускаются **9 обязательных для релиза проверок**: `lint`, `test (22)`, `test (24)`, `smoke`, `audit`, `coverage`, `version-consistency`, `docs` и `oia`. Защита ветки сейчас требует только **7** из них; `docs` и `oia` обязательны для релиза, но не защищены (проверено онлайн 2026-07-23). `test-macos` — единственный совещательный job с `continue-on-error`. `docker` способен сделать CI-workflow красным, но не защищён; CodeQL запускает две отдельные незащищённые проверки через [настройку GitHub по умолчанию](https://docs.github.com/code-security/code-scanning/automatically-scanning-your-code-for-vulnerabilities-and-errors/configuring-default-setup-for-code-scanning). Перед npm publish `release.yml` повторно проверяет все 9 на помеченном SHA. |
| **Покрытие** | Строки ≥86% · выражения ≥82% · функции ≥75% · ветви ≥74% (контролируется гейтом) |
| **Релизы** | npm + релиз на GitHub на каждый тег · semver · **подтверждённое происхождение сборки** (npm + Sigstore, SLSA Build L2; генератор L3 в дорожной карте) |
| **Стабильность** | v3.0+ с гарантиями semver — каждый CLI-флаг, имя инструмента, MCP-ресурс, промпт, экспортируемый символ является контрактом |

Полная позиция: **[SECURITY.md](./SECURITY.md)** · Поверхность стабильности: **[STABILITY.md](./STABILITY.md)** · Уязвимости: `oomkapwn@gmail.com`.

---

## ❓ FAQ

**Нужно ли устанавливать Obsidian?** Нет. Читает `.md` + `.canvas` + `.pdf` напрямую. Работает с любым хранилищем в формате Obsidian.

**Будет ли он писать в моё хранилище?** Нет, если только вы не передадите `--enable-write`. Все 7 инструментов записи управляемы; деструктивные поддерживают `dry_run`.

**Куда-нибудь отправляются данные?** Исходящие загрузки выполняются только явными командами получения данных: `enquire-mcp setup`, `enquire-mcp build-embeddings` и `enquire-mcp install-model` могут загрузить ONNX-веса с HuggingFace, а `enquire-mcp install-ocr-lang` — языковой пакет Tesseract для OCR. Режим serve никогда не делает исходящих HTTP-запросов. Эмбеддинги + реранкер работают на CPU локально.

**Производительность?** Холодная сборка FTS5: ~5с/1k заметок, ~30с/50k. BM25-запрос: <100 мс всегда. Сборка эмбеддингов: ~30 мс/чанк на M1. **HNSW top-10: менее 10 мс на любом масштабе.** Холодный старт serve: ~50 мс при персистентности HNSW.

**Языки?** Эмбеддер по умолчанию — `paraphrase-multilingual-MiniLM-L12-v2` (50+ языков), сквозным образом проверенный на двуязычных русско-английских хранилищах. Кросс-энкодер по умолчанию — `rerank-bge` (English-only; единственный вариант каталога, проверенный сквозным образом); многоязычные варианты reranker сейчас не проходят проверку совместимости tokenizer в transformers.js. Токенизация CJK/тайского/кхмерского выполняется через `Intl.Segmenter`.

**Запуск удалённо?** Да — `serve-http` открывает тот же сервер по [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http). Поставьте впереди Tailscale Funnel или Cloudflare Tunnel для HTTPS. Работает с вебом claude.ai, кастомным GPT в ChatGPT, режимом HTTP в Cursor, мобильными MCP-клиентами. См. **[docs/http-transport.md](./docs/http-transport.md)**.

---

## 🚀 Релизы

**v3.0.0 — стабильный канал.** Дорожная карта поиска ветки v2.x завершена, и публичная поверхность теперь [с гарантиями semver](./STABILITY.md). Подборка ключевых моментов:

`v2.0` гибридный поиск (BM25+TF-IDF+эмбеддинги через RRF) · `v2.6` удалённый MCP · `v2.7-2.8` вплетённые PDF · `v2.9` BGE-реранкер · `v2.10` OCR · `v2.11` doctor + setup · `v2.12` фреймворк оценки · `v2.13` HNSW · `v2.14` сессии с состоянием · `v2.15` late-chunking · `v2.16` персистентность HNSW · `v2.17` int8-квантизация · `v3.8.0` стабильная · `v3.8.7` усиление HTTP-транспорта · **`v3.9.0` стабильная**: embed-синхронизация watcher для PDF с OCR, живое обновление HNSW в памяти при изменении файлов, адаптивное дозаполнение HNSW R-10 (закрывает недовозврат при >66% исключённых). · **`v3.10` стабильная**: свежесть с осознанием забывания — `age_days` + флаг `stale` + опциональное переранжирование `--recency-weight` + `obsidian_search` с учётом frontmatter.

Канал: `npm install @oomkapwn/enquire-mcp` → последняя стабильная (`@latest` = v3.11.x). Предрелиз: `npm install @oomkapwn/enquire-mcp@rc` (последний кандидат на релиз — см. [CHANGELOG.md](./CHANGELOG.md)). Полный список изменений: **[CHANGELOG.md](./CHANGELOG.md)** · Дальнейший план: **[ROADMAP.md](https://github.com/oomkapwn/enquire-mcp/blob/main/ROADMAP.md)**.

---

## 🤝 Участие

```bash
git clone https://github.com/oomkapwn/enquire-mcp.git
cd enquire-mcp && npm install
npm test       # полный набор (1710 тестов)
npm run lint   # ноль предупреждений
npm run build  # tsc → dist/
```

Issue, PR и идеи приветствуются.

---

## 📜 Лицензия

MIT. Создано [Alex (@OomkaBear)](https://github.com/oomkapwn). Названо в честь [прототипа WWW Тима Бернерса-Ли 1980 года ENQUIRE](https://en.wikipedia.org/wiki/ENQUIRE) — оригинальной гипертекстовой системы, ещё до веба. Исходная спецификация гласила: вы могли спросить систему о чём угодно. **enquire-mcp приносит это в ваше хранилище.**
