# Changelog

## 0.1.0 — 2026-10-25

Initial release.

- Deterministic simulated organisation (customers, invoices, tickets, files, calendar, staff).
- Four MCP servers (18 core tools with input and output schemas) and 144 distractor tools across six domains.
- Four interaction conditions: direct tool calling, tool search, Code Mode, and Code Mode with progressive API discovery.
- JSON Schema → TypeScript code generation and a QuickJS (WebAssembly) sandbox with memory, time and host-call limits.
- 40 tasks with programmatic verifiers and reference solutions; 15-task pilot subset.
- Ollama and OpenAI-compatible backends (Groq, Gemini and OpenRouter presets), with a response cache and rate limiting.
- Resumable experiment runner with full provenance per run, gzipped traces and sharding.
- Report generator: Wilson intervals, exact McNemar paired tests, HTML dashboard, and a README results section generated from raw logs.
- CLI commands: `bench`, `report`, `inspect`, `codegen`, `tasks`, `sizes`.
