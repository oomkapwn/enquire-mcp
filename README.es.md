<div align="center">

<a href="https://github.com/oomkapwn/enquire-mcp"><img src="./assets/social-preview.png" alt="enquire-mcp — el MCP de Obsidian más avanzado. Memoria a largo plazo para agentes de IA." width="100%"></a>

# enquire-mcp

<sub>[English](./README.md) · [中文](./README.zh.md) · **Español** · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md) · [Русский](./README.ru.md) · [Português](./README.pt.md) · [Français](./README.fr.md) · [日本語](./README.ja.md)</sub>

### El MCP de Obsidian más avanzado. Memoria a largo plazo para agentes de IA.

**Deja de reexplicarle el contexto a Claude, Cursor, ChatGPT, Codex y OpenClaw en cada sesión. Tus notas de Obsidian se convierten en una memoria compartida y consultable entre todos los agentes compatibles con MCP: tu conocimiento, cualquier modelo, tuyo para siempre.**

[![npm](https://img.shields.io/npm/v/@oomkapwn/enquire-mcp.svg?label=npm&color=cb3837)](https://www.npmjs.com/package/@oomkapwn/enquire-mcp)
[![stable](https://img.shields.io/badge/v3.11.x-stable-brightgreen.svg)](./STABILITY.md)
[![build provenance](https://img.shields.io/badge/build_provenance-SLSA_L2-blue.svg)](https://slsa.dev/spec/v1.0/levels#build-l2)
[![MCP](https://img.shields.io/badge/MCP-1.29-8A2BE2.svg)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)

**[⚡ Instalación en 30 segundos](#-inicio-rápido) · [🧠 Casos de uso](#-casos-de-uso) · [📊 Benchmarks](./docs/benchmarks.md) · [📖 Referencia de la API](https://oomkapwn.github.io/enquire-mcp/) · [💬 Comparar alternativas](./docs/COMPARISON.md)**

**Claude Code —— en una sola línea:**

```bash
claude mcp add obsidian -- npx -y @oomkapwn/enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
```

</div>

> 📌 Este documento es la traducción al español de [README.md](./README.md), para facilitar la lectura a quienes hablan español; ante cualquier discrepancia, **prevalece la versión en inglés** (que se actualiza con cada publicación).

---

## El problema

Cada sesión de IA empieza desde cero. Vuelves a explicar tu proyecto, tus decisiones de diseño, las conclusiones de la investigación de la semana pasada. Las funciones de "memoria" de los proveedores ([Claude Memory](https://www.anthropic.com/news/memory-and-tool-use), [ChatGPT Memory](https://openai.com/index/memory-and-new-controls-for-chatgpt/), la memoria de Cursor) encierran tu conocimiento en la nube de un único proveedor, y lo vuelven a olvidar en cuanto cambias de herramienta. **Tu conocimiento no para de empezar de nuevo.**

## La solución

Tu bóveda de Obsidian se convierte en **memoria a largo plazo persistente y consultable** para cualquier agente compatible con MCP. Una sola instalación: tu conocimiento queda al instante accesible desde Claude Code, Claude Desktop, Cursor, el GPT personalizado de ChatGPT, Codex, OpenClaw y cualquier otro cliente MCP. Archivos markdown planos **que son tuyos**, indexados localmente, buscados con todo el stack moderno de recuperación de información (IR), y recordados en cada sesión y con cada modelo.

**Anclado en tus textos, no extraído.** Las herramientas de memoria conversacional (mem0, Zep, Supermemory, Memobase) *extraen* hechos de tus registros de chat hacia un almacén aparte que no puedes leer. enquire-mcp es lo contrario: está **anclado en el conocimiento que ya escribiste** —tus propias notas `.md`, literales, con citas— de modo que la recuperación es auditable, editable en cualquier editor y nunca un resumen con pérdidas de un chat que recuerdas a medias. Y a diferencia de las plataformas de memoria de ***flota*** del lado del servidor —almacenes en la nube multiinquilino que parafrasean el tráfico de los agentes hacia una base de datos compartida— enquire es **monousuario y local-first**: una única bóveda que posees por completo y que puedes leer, editar y borrar tú mismo, con cero llamadas a la nube durante el servicio.

**Anclado —— y consciente de la frescura.** Recordar un hecho es solo la mitad del problema; saber si sigue siendo *cierto* es la otra mitad. El [benchmark Memora](https://arxiv.org/abs/2604.20006) (abril de 2026) mostró que los sistemas de memoria fallan sistemáticamente al reutilizar hechos obsoletos: recuerdan una nota de hace un año como si se hubiera escrito hoy. Como la memoria de enquire *son* tus archivos markdown reales, cada resultado de búsqueda incluye `age_days` (días de antigüedad) y una marca `stale` (obsoleto) derivada de la hora real de última modificación de la nota, y puedes activar el ranking ponderado por recencia (`--recency-weight`) para que las notas más recientes salgan primero. Tu conocimiento, consciente de la frescura, no un bloque atemporal.

> **Lo que hace diferente a enquire-mcp**:
> 1. **Neutral respecto al proveedor.** Tu memoria vive en archivos `.md`. Cambia de Claude a Cursor: tu memoria viaja contigo.
> 2. **Recuperación de primer nivel.** BM25 híbrido + embeddings multilingües + reranker cross-encoder BGE fusionados mediante RRF, escalados con HNSW + cuantización int8. El mismo stack de IR que montaría una startup de búsqueda, en código abierto y en un solo binario.
> 3. **Cero llamadas a la nube durante el servicio.** Modelos en caché local (una descarga única desde HuggingFace). El contenido de tu bóveda nunca sale de tu máquina. Seguro para entornos aislados por defecto.
> 4. **Recuperación consciente de la frescura.** Cada resultado informa de la antigüedad de la nota; el reordenamiento por recencia opcional permite que un agente prefiera el conocimiento reciente y marque los hechos obsoletos para reverificación: la frontera consciente del olvido, construida sobre el `mtime` que tus archivos ya tienen.

**46 herramientas · 19 prompts MCP · 1433+ pruebas unitarias · 50+ idiomas · v3.11.x estable · ligado a semver · MIT · procedencia de compilación en npm (SLSA L2).**

---

## ⚡ Inicio rápido

```bash
npm install -g @oomkapwn/enquire-mcp
enquire-mcp serve --vault ~/Documents/Obsidian\ Vault
```

Conéctalo a cualquier cliente MCP:

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

📂 Configuraciones listas para usar en [`examples/`](./examples/) —— **Claude Desktop**, **Cursor**, **GPT personalizado de ChatGPT** (MCP remoto sobre HTTP), además de un conjunto de consultas de ejemplo para el arnés de evaluación.

**¿Quieres toda la potencia híbrida?** Puesta en marcha sin fricción, en un comando:

```bash
enquire-mcp setup --vault <path>     # descarga el modelo, construye FTS5 + embed-db
enquire-mcp serve --vault <path> --persistent-index --enable-reranker --use-hnsw
enquire-mcp doctor --vault <path>    # chequeo de salud con código de color ✓/⚠/✗
```

---

## 🧠 Casos de uso

**1 —— Memoria a largo plazo para agentes de IA.** Conecta tu bóveda de Obsidian a cualquier agente compatible con MCP (Claude Code, Claude Desktop, Cursor, ChatGPT, Codex, OpenClaw). El agente dispone entonces de una recuperación semántica duradera sobre cada nota de reunión, entrada de diario, registro de investigación y documento de decisión que hayas escrito jamás, a través de sesiones, modelos y proveedores. A diferencia de `Claude Memory` o `ChatGPT Memory`, tu conocimiento no queda encerrado en la nube de un proveedor; vive en markdown plano que posees y puedes migrar libremente.

**2 —— Base de conocimiento personal / segundo cerebro.** La recuperación híbrida saca a la luz la nota correcta para *cualquier* formulación, en cualquiera de más de 50 idiomas. Pregunta en inglés por una entrada de diario en ruso de hace dos años y obtén el resultado correcto. El graph-boost de wikilinks reordena las notas que están en el centro de tu grafo de conocimiento. GraphRAG-light revela comunidades temáticas: descubre conexiones que olvidaste haber hecho. Los PDF se mezclan en la búsqueda con citas `[page: N]`, de modo que artículos de investigación y transcripciones de reuniones pasan a ser memoria de primera clase.

**3 —— RAG agéntico / ingeniería de contexto.** `obsidian_search` expone las puntuaciones por señal para que el agente vea *por qué* se posicionó cada resultado. HyDE reescribe de antemano las consultas vagas en respuestas hipotéticas ricas antes de la recuperación. La descomposición en subpreguntas resuelve preguntas multi-salto dividiéndolas en subconsultas independientes y fusionando los resultados. El arnés de evaluación incorporado (NDCG / Recall / MRR) te permite medir la calidad de recuperación con tus propias consultas en lugar de confiar en los benchmarks del proveedor.

---

## 🚫 Cuándo enquire-mcp *no* es la herramienta adecuada

No-objetivos honestos: recurre a otra cosa cuando:

- **Quieres búsqueda literal de cadenas / regex.** `ripgrep` / `grep` es más rápido y exacto para "encuentra este token preciso". enquire brilla en la recuperación *conceptual*: sinónimos, idiomas distintos, "qué dije sobre X". Usa ambos: `rg` para lo literal, enquire para el significado.
- **Tu conocimiento vive en registros de chat, no en notas.** enquire está *anclado* en el markdown que tú escribiste. Las herramientas de memoria conversacional (mem0, Zep, Supermemory) que *extraen* hechos de transcripciones de chat hacia un almacén aparte son otra categoría: consulta la [comparación](./docs/COMPARISON.md).
- **Necesitas búsqueda multiusuario / alojada / sincronizada.** enquire es local-first y de una sola bóveda por diseño: sin índice multiinquilino del lado del servidor.
- **Tus fuentes no son Markdown ni PDF.** `.md` / `.canvas` / `.base` / `.pdf` son de primera clase; otros formatos necesitan conversión previa.
- **Quieres una GUI o un plugin dentro de Obsidian.** enquire es un servidor MCP / CLI sin interfaz: *complementa* a Obsidian, no lo sustituye. (Smart Connections es la opción de plugin dentro de la app.)
- **Necesitas búsqueda submilisegundo sobre millones de notas.** HNSW ofrece top-K en menos de 10 ms a gran escala, pero enquire apunta a bóvedas personales / de equipo, no a corpus a escala web.

---

## 🏆 Por qué es el mejor

**Seis funciones que ningún otro Obsidian-MCP tiene en absoluto** (GraphRAG-light, ejecución autónoma de `.base`, HyDE, cuantización int8, late-chunking, arnés de evaluación incorporado), **más todo el stack moderno de IR** (BM25 + embeddings + reranking con cross-encoder + HNSW), del que los competidores ofrecen como mucho uno o dos elementos. Cara a cara:

| Capacidad | enquire-mcp | Smart Connections | Otros Obsidian-MCP |
|---|:---:|:---:|:---:|
| Recuperación híbrida (BM25 + TF-IDF + embeddings, fusionados con RRF) | ✅ | ❌ | ❌ |
| **Reranking con cross-encoder** (BGE, +15.5 NDCG@10 medido) | ✅ | ❌ | ❌ |
| **Índice vectorial HNSW** (top-K en menos de 10 ms, persistido) | ✅ | ❌ | ❌ |
| **Cuantización vectorial int8** (embed-db ~4× más pequeña) | ✅ | ❌ | ❌ |
| **Búsqueda semántica multilingüe** (50+ idiomas, en el dispositivo) | ✅ | 💰 de pago | ❌ |
| **PDF mezclados en la búsqueda híbrida** (citas `[page: N]` + OCR) | ✅ | ❌ | ❌ |
| **Graph-boost de wikilinks** como señal de recuperación | ✅ | ❌ | ❌ |
| **Arnés de evaluación de calidad de recuperación incorporado** (NDCG, Recall, MRR) | ✅ | ❌ | ❌ |
| **MCP remoto** sobre HTTP + autenticación bearer + sesiones con estado | ✅ | ❌ | parcial |
| **Nativo de MCP** (Claude · Cursor · ChatGPT · Codex · OpenClaw · cualquier cliente) | ✅ | ❌ solo Obsidian | varía |
| **Filtro de privacidad** verificado en cada ruta de búsqueda + escritura | ✅ | n/d | ❌ |
| **46 herramientas de producción** (34 de lectura siempre activas + 4 opcionales + 7 escrituras restringidas + 1 de retroalimentación) | ✅ | n/d | varía |
| **GraphRAG-light** (detección de comunidades de wikilinks por modularidad de Louvain) | ✅ **solo aquí** | ❌ | ❌ |
| **Ejecución autónoma de consultas `.base`** (funciona sin Obsidian abierto) | ✅ **solo aquí** | ❌ | ❌ |
| **Recuperación HyDE** + descomposición en subpreguntas | ✅ **solo aquí** | ❌ | ❌ |
| **Procedencia de compilación firmada** (npm + Sigstore, SLSA L2) | ✅ | n/d | ❌ |
| Autónomo (sin necesidad de plugin de Obsidian) | ✅ | ❌ requiere Obsidian | varía |
| Licencia | MIT, gratis | propietaria, de pago | varía |

<sub>Comparación basada en las capacidades públicas de cada proyecto a fecha de la versión estable v3.8.x. Smart Connections es un plugin de pago de Obsidian (no un servidor MCP). "Otros Obsidian-MCP" se refiere a los servidores Obsidian-MCP públicos de código abierto en GitHub en el momento de redactar esto. Los benchmarks de recuperación de extremo a extremo de enquire-mcp se publican en <a href="./docs/benchmarks.md"><code>docs/benchmarks.md</code></a>: el delta medido de `rerank-bge` es +24.7 MRR / +15.5 NDCG@10 frente al híbrido puro en una ablación de 60 consultas.</sub>

> Afirmación estratégica: enquire-mcp es el backend de código abierto para [wikis de LLM al estilo Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) sobre tu bóveda de Obsidian existente. Conocimiento que se acumula, trazable hasta sus fuentes.

---

## 🏗️ Cómo funciona la recuperación

`obsidian_search` detecta automáticamente las señales disponibles y degrada con elegancia: BM25 / FTS5 + TF-IDF + embeddings (HNSW) → fusión RRF (k=60) → graph-boost de wikilinks (α × grado de entrada, PageRank personalizado de un paso) → reranker cross-encoder BGE → resultados ordenados con observabilidad `per_signal`. Cada resultado devuelve `per_signal: { bm25, tfidf, embeddings }`, para que veas *por qué* se posicionó.

Activable por niveles, según lo que necesites:

| Nivel | Configuración | Lo que obtienes |
|---|---|---|
| **1** | `serve --vault <path>` | Coseno TF-IDF (cero configuración, instantáneo) |
| **2** | + `--persistent-index` | + BM25 / FTS5 (top-10 en menos de 100 ms) |
| **3** | + `setup` (descarga el modelo + construye embed-db) | + embeddings multilingües de ML |
| **4** | + `--enable-reranker` | + cross-encoder BGE (+15.5 NDCG@10 medido) |
| **5** | + `--use-hnsw` | + top-K en menos de 10 ms a escala de millones de chunks |
| **6** | + `--include-pdfs` | + PDF mezclados en todo lo anterior |
| **7** | `serve-http --bearer-token …` | + MCP remoto (web de Claude.ai, ChatGPT, Cursor HTTP, móvil) |

---

## 🛠️ Las 46 herramientas

46 herramientas en total: 34 de lectura siempre activas (incl. el paraguas `obsidian_search`) + 4 opcionales + 7 escrituras restringidas + 1 de retroalimentación de bucle cerrado. Referencia completa en **[docs/api.md](./docs/api.md)**, que abarca: búsqueda y recuperación, wikilinks y grafo, frontmatter y Dataview, Canvas, Obsidian Bases, PDF + OCR, detección de comunidades, herramientas de escritura (requieren `--enable-write`), etc.

---

## 🛡️ Confianza

| Aspecto | Postura |
|---|---|
| **Por defecto** | Solo lectura —— se requiere `--enable-write` para las 7 herramientas de escritura |
| **Mínimo privilegio** | `--disabled-tools` / `--enabled-tools` exponen una superficie mínima (p. ej. un agente de investigación de solo lectura obtiene solo `obsidian_search` + `obsidian_read_note`) |
| **Seguridad de rutas** | Comprobación de realpath en cada lectura+escritura; se rechazan los symlinks que salen de la bóveda |
| **Filtro de privacidad** | Verificado en las rutas de recurso de FTS5 + embed-db + chunk; fail-closed ante listas de permitidos/denegados vacías |
| **Transporte HTTP** | Autenticación bearer (SHA-256 de tiempo constante + `timingSafeEqual`), límite de tasa por token, CORS estricto |
| **Publicación de versiones** | npm + GitHub release por cada tag · semver · **procedencia de compilación firmada** (npm + Sigstore, SLSA L2) |

Postura completa: **[SECURITY.md](./SECURITY.md)** · Superficie de estabilidad: **[STABILITY.md](./STABILITY.md)** · Vulnerabilidades: `oomkapwn@gmail.com`.

---

## ❓ Preguntas frecuentes

**¿Hace falta tener instalado Obsidian?** No. Lee `.md` + `.canvas` + `.pdf` directamente. Funciona con cualquier bóveda en formato Obsidian.

**¿Escribirá en mi bóveda?** No, a menos que pases `--enable-write`. Las 7 herramientas de escritura están restringidas; las destructivas admiten `dry_run`.

**¿Se envían datos a algún sitio?** Solo al ejecutar `enquire-mcp install-model` (descarga los pesos ONNX desde HuggingFace, una sola vez). El modo serve nunca realiza HTTP saliente. Los embeddings y el reranker se ejecutan localmente en la CPU.

**¿Rendimiento?** Construcción en frío de FTS5: ~5s/1k notas, ~30s/50k. Consulta BM25: siempre <100ms. **HNSW top-10: menos de 10 ms a cualquier escala.** Arranque en frío de serve: ~50ms con persistencia HNSW.

**¿Idiomas?** Por defecto `paraphrase-multilingual-MiniLM-L12-v2` (50+ idiomas), cross-encoder multilingüe. Tokenización CJK / tailandés / jemer mediante `Intl.Segmenter`.

**¿Ejecución remota?** Sí —— `serve-http` expone el mismo servidor a través de [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http). Ponle delante Tailscale Funnel o Cloudflare Tunnel para HTTPS. Funciona con la web de claude.ai, el GPT personalizado de ChatGPT, el modo HTTP de Cursor y clientes MCP móviles. Consulta **[docs/http-transport.md](./docs/http-transport.md)**.

---

## 🚀 Publicaciones

Canal: `npm install @oomkapwn/enquire-mcp` → última versión estable (`@latest` = v3.11.x). Versión preliminar: `npm install @oomkapwn/enquire-mcp@rc` (el último candidato a versión). Registro de cambios completo en **[CHANGELOG.md](./CHANGELOG.md)** · Hoja de ruta en **[ROADMAP.md](https://github.com/oomkapwn/enquire-mcp/blob/main/ROADMAP.md)**.

## 🤝 Cómo contribuir

Se agradecen issues y PR. Flujo de trabajo de desarrollo en **[CONTRIBUTING.md](https://github.com/oomkapwn/enquire-mcp/blob/main/CONTRIBUTING.md)**; guía del repositorio orientada a agentes en **[AGENTS.md](https://github.com/oomkapwn/enquire-mcp/blob/main/AGENTS.md)**.

## 📜 Licencia

[MIT](./LICENSE) © Alex (@OomkaBear)
