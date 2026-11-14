# AGENTS.md

- Цель: локальный менеджер агентов opencode V2. Ноль зависимостей, сервер на `node:http`.
- `server.mjs` — API + статика. `frontmatter.mjs` — разбор и сборка markdown-агентов. `public/` — интерфейс без сборки.
- Незнакомые поля frontmatter сохраняются дословно (`extra`): старые V1-файлы не должны терять `permission`/`tools`.
- Проверки перед коммитом: `node frontmatter.test.mjs`; API — `node server.mjs &` + `node smoke-test.mjs`.
- Работаем в `main` и пушим сразу в origin.
