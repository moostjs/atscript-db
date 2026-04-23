---
layout: home

hero2:
  text: "Your schema is your entire backend"
  tagline: "Tables, relations, views, sync, and REST — from a single .as file. No ORM configuration. No migration files. No boilerplate."

actions:
  - theme: brand
    text: Quick Start
    link: /guide/quick-start
  - theme: alt
    text: View on GitHub
    link: https://github.com/moostjs/atscript-db
---

## AI Agent Skill

Atscript DB provides a unified skill for AI coding agents (Claude Code, Cursor, Windsurf, Codex, etc.) that covers the DB layer — `@db.*` annotations, adapters (SQLite, PostgreSQL, MySQL, MongoDB), schema sync, relations, `moost-db` REST, and the browser client.

```bash
npx skills add moostjs/atscript-db
```

For the atscript language itself (`.as` syntax, `@meta.*` / `@expect.*`, primitives, `asc` codegen, runtime `Validator`), also install the companion skill:

```bash
npx skills add moostjs/atscript
```

Learn more about AI agent skills at [skills.sh](https://skills.sh).
