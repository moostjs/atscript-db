<script setup>
import { onMounted, nextTick, ref, watch } from "vue";
// oxlint-disable-next-line import/named -- vitepress re-exports these
import { useData, useRoute } from "vitepress";
import DefaultTheme from "vitepress/theme";
import VPButton from "vitepress/dist/client/theme-default/components/VPButton.vue";
import SnippetTable from "./snippets/snippet-table.md";
import SnippetRelations from "./snippets/snippet-relations.md";
import SnippetView from "./snippets/snippet-view.md";
import SnippetCrud from "./snippets/snippet-crud.md";
import SnippetRest from "./snippets/snippet-rest.md";
import sqliteLogo from "./icons/sqlite.svg?raw";
import postgresLogo from "./icons/postgres.svg?raw";
import mysqlLogo from "./icons/mysql.svg?raw";
import mongodbLogo from "./icons/mongodb.svg?raw";

const adapterEntries = [
  {
    href: "/adapters/sqlite",
    name: "SQLite",
    note: "Zero-config, embedded",
    logo: sqliteLogo,
    color: "#0F80CC",
  },
  {
    href: "/adapters/postgresql",
    name: "PostgreSQL",
    note: "Full-featured, production-ready",
    logo: postgresLogo,
    color: "#336791",
  },
  {
    href: "/adapters/mysql",
    name: "MySQL",
    note: "Widely deployed, familiar",
    logo: mysqlLogo,
    color: "#4479A1",
  },
  {
    href: "/adapters/mongodb",
    name: "MongoDB",
    note: "Document store, flexible",
    logo: mongodbLogo,
    color: "#47A248",
  },
];

const { Layout } = DefaultTheme;
const { frontmatter } = useData();
const route = useRoute();

const copiedCmd = ref("");
let copyTimer;
async function copyCmd(cmd) {
  try {
    await navigator.clipboard.writeText(cmd);
    copiedCmd.value = cmd;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copiedCmd.value = "";
    }, 1400);
  } catch {
    // ignore
  }
}

function setupScrollAnimations() {
  nextTick(() => {
    const observer = new IntersectionObserver( // oxlint-disable-line no-undef -- browser global
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("visible");
            observer.unobserve(e.target);
          }
        });
      },
      { threshold: 0.1 },
    );
    document.querySelectorAll(".animate-in").forEach((el) => {
      // oxlint-disable-line no-undef -- browser global
      el.classList.remove("visible");
      observer.observe(el);
    });
  });
}

onMounted(setupScrollAnimations);
watch(() => route.path, setupScrollAnimations);
</script>

<template>
  <Layout>
    <template #home-hero-before>
      <!-- ═══════════════════ Hero ═══════════════════ -->
      <div class="custom-hero">
        <div class="hero-dots-bg" aria-hidden="true"></div>
        <div class="hero-inner">
          <div class="hero-main">
            <p class="hero-kicker">
              Database layer for <a href="https://atscript.dev" class="kicker-link">Atscript</a>
            </p>
            <h1 class="hero-name">Atscript DB</h1>
            <p class="hero-text">{{ frontmatter.hero2.text }}</p>
            <p class="hero-tagline">{{ frontmatter.hero2.tagline }}</p>
            <div v-if="frontmatter.actions" class="actions">
              <div v-for="action in frontmatter.actions" :key="action.link" class="action">
                <VPButton
                  tag="a"
                  size="medium"
                  :theme="action.theme"
                  :text="action.text"
                  :href="action.link"
                />
              </div>
            </div>
          </div>
          <div class="hero-image">
            <div class="image-container">
              <div class="constellation" aria-hidden="true">
                <!-- Schema constellation: FK paths + travelling data pulses -->
                <svg class="hero-fk-svg" viewBox="0 0 400 400" aria-hidden="true">
                  <defs>
                    <path id="fk-top" d="M 80 80 Q 200 110 320 80" />
                    <path id="fk-bottom" d="M 80 320 Q 200 290 320 320" />
                    <path id="fk-left" d="M 60 100 Q 30 200 60 300" />
                    <path id="fk-right" d="M 340 100 Q 370 200 340 300" />
                  </defs>
                  <use href="#fk-top" class="fk-path" />
                  <use href="#fk-bottom" class="fk-path" />
                  <use href="#fk-left" class="fk-path" />
                  <use href="#fk-right" class="fk-path" />
                  <circle class="fk-pulse" r="3.5">
                    <animateMotion dur="3.6s" repeatCount="indefinite" rotate="auto">
                      <mpath href="#fk-top" />
                    </animateMotion>
                  </circle>
                  <circle class="fk-pulse" r="3.5">
                    <animateMotion dur="4.2s" repeatCount="indefinite" rotate="auto" begin="-1.4s">
                      <mpath href="#fk-bottom" />
                    </animateMotion>
                  </circle>
                  <circle class="fk-pulse" r="3.5">
                    <animateMotion dur="5s" repeatCount="indefinite" rotate="auto" begin="-2.1s">
                      <mpath href="#fk-left" />
                    </animateMotion>
                  </circle>
                  <circle class="fk-pulse" r="3.5">
                    <animateMotion dur="4.6s" repeatCount="indefinite" rotate="auto" begin="-3s">
                      <mpath href="#fk-right" />
                    </animateMotion>
                  </circle>
                </svg>

                <!-- Mini schema cards (4 tables, fanned around the logo) -->
                <div class="schema-card schema-card-tl" aria-hidden="true">
                  <div class="schema-card-head">users</div>
                  <div class="schema-card-row r-l"></div>
                  <div class="schema-card-row r-m"></div>
                  <div class="schema-card-row r-s"></div>
                </div>
                <div class="schema-card schema-card-tr" aria-hidden="true">
                  <div class="schema-card-head">orders</div>
                  <div class="schema-card-row r-m"></div>
                  <div class="schema-card-row r-l"></div>
                  <div class="schema-card-row r-s"></div>
                </div>
                <div class="schema-card schema-card-bl" aria-hidden="true">
                  <div class="schema-card-head">products</div>
                  <div class="schema-card-row r-s"></div>
                  <div class="schema-card-row r-l"></div>
                  <div class="schema-card-row r-m"></div>
                </div>
                <div class="schema-card schema-card-br" aria-hidden="true">
                  <div class="schema-card-head">reviews</div>
                  <div class="schema-card-row r-l"></div>
                  <div class="schema-card-row r-s"></div>
                  <div class="schema-card-row r-m"></div>
                </div>
              </div>

              <img src="/logo.svg" alt="Atscript DB" class="image-src" />
            </div>
          </div>
        </div>
      </div>

      <!-- ═══════════════════ 1. Define Your Tables ═══════════════════ -->
      <section class="section-story bg-diagonal">
        <div class="section-inner">
          <div class="story-grid animate-in">
            <div class="story-copy">
              <h2 class="section-heading">Define your tables</h2>
              <p class="story-desc">
                Stop scattering your data definitions across ORM configs, migration scripts, and
                validation layers. One <code>.as</code> file holds your table name, columns, types,
                indexes, defaults, and constraints. Nothing else to maintain.
              </p>
              <div class="story-tags">
                <span class="story-tag">@db.table</span>
                <span class="story-tag">@meta.id</span>
                <span class="story-tag">@db.default.*</span>
                <span class="story-tag">@db.index.*</span>
              </div>
              <div class="story-links">
                <a href="/api/tables" class="story-link">Tables & Fields</a>
                <a href="/api/indexes" class="story-link">Indexes & Constraints</a>
              </div>
            </div>
            <div class="story-code">
              <div class="code-label brand-label">product.as</div>
              <div class="code-block brand-block">
                <SnippetTable />
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ═══════════════════ 2. Declare Relations ═══════════════════ -->
      <section class="section-story">
        <div class="section-inner">
          <div class="story-grid story-grid-reverse animate-in">
            <div class="story-copy">
              <h2 class="section-heading">Declare relations in the model</h2>
              <p class="story-desc">
                Foreign keys, navigation properties, and cascade rules belong with the data they
                describe — not in a separate config file you have to keep in sync by hand.
              </p>
              <div class="story-tags">
                <span class="story-tag">@db.rel.FK</span>
                <span class="story-tag">@db.rel.to</span>
                <span class="story-tag">@db.rel.from</span>
                <span class="story-tag">@db.rel.onDelete</span>
              </div>
              <div class="story-links">
                <a href="/relations/" class="story-link">Foreign Keys</a>
                <a href="/relations/navigation" class="story-link">Navigation Properties</a>
              </div>
            </div>
            <div class="story-code">
              <div class="code-label brand-label">order.as</div>
              <div class="code-block brand-block">
                <SnippetRelations />
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ═══════════════════ 3. Views & Aggregations ═══════════════════ -->
      <section class="section-story bg-diagonal">
        <div class="section-inner">
          <div class="story-grid animate-in">
            <div class="story-copy">
              <h2 class="section-heading">Views without raw SQL</h2>
              <p class="story-desc">
                JOINs, filters, and GROUP BY aggregations — declared in your schema, not buried in
                SQL strings or query builder chains. Schema sync generates the
                <code>CREATE VIEW</code> for you.
              </p>
              <div class="story-tags">
                <span class="story-tag">@db.view</span>
                <span class="story-tag">@db.view.joins</span>
                <span class="story-tag">@db.agg.sum</span>
                <span class="story-tag">@db.agg.count</span>
              </div>
              <div class="story-links">
                <a href="/views/" class="story-link">Defining Views</a>
                <a href="/views/aggregation-views" class="story-link">Aggregation Views</a>
              </div>
            </div>
            <div class="story-code">
              <div class="code-label brand-label">order-stats.as</div>
              <div class="code-block brand-block">
                <SnippetView />
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ═══════════════════ 4. Type-Safe CRUD ═══════════════════ -->
      <section class="section-story">
        <div class="section-inner">
          <div class="story-grid story-grid-reverse animate-in">
            <div class="story-copy">
              <h2 class="section-heading">Type-safe CRUD out of the box</h2>
              <p class="story-desc">
                Insert, query, update, and delete with a clean API that knows your schema. Filters,
                sorting, pagination, and full-text search — all type-checked against your model.
              </p>
              <div class="story-tags">
                <span class="story-tag">insertOne</span>
                <span class="story-tag">findMany</span>
                <span class="story-tag">search</span>
                <span class="story-tag">$with</span>
              </div>
              <div class="story-links">
                <a href="/api/crud" class="story-link">CRUD Operations</a>
                <a href="/api/queries" class="story-link">Queries & Filters</a>
              </div>
            </div>
            <div class="story-code">
              <div class="code-label brand-label">usage.ts</div>
              <div class="code-block brand-block">
                <SnippetCrud />
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ═══════════════════ 5. Schema Sync ═══════════════════ -->
      <section class="section-story bg-diagonal">
        <div class="section-inner">
          <div class="story-grid animate-in">
            <div class="story-copy">
              <h2 class="section-heading">Sync, not migrate</h2>
              <p class="story-desc">
                Migration files accumulate, drift, and break. Schema sync compares your
                <code>.as</code> definitions against the live database and applies the difference.
                Hash-gated — zero cost when nothing changed. Safe mode blocks destructive changes in
                production.
              </p>
              <div class="story-tags">
                <span class="story-tag">asc db sync</span>
                <span class="story-tag">drift detection</span>
                <span class="story-tag">distributed locking</span>
                <span class="story-tag">CI/CD</span>
              </div>
              <div class="sync-terminal animate-in">
                <div class="terminal-bar">
                  <span class="terminal-dot"></span>
                  <span class="terminal-dot"></span>
                  <span class="terminal-dot"></span>
                </div>
                <div class="terminal-body">
                  <div class="terminal-line"><span class="t-prompt">$</span> asc db sync</div>
                  <div class="terminal-line t-muted">Compiling .as files...</div>
                  <div class="terminal-line t-muted">
                    {{ 'Schema hash: <span class="t-hash">a7f3c912</span> (changed)' }}
                  </div>
                  <div class="terminal-line t-muted">Acquiring lock...</div>
                  <div class="terminal-line t-add">
                    {{ "+ CREATE TABLE products (id, name, sku, ...)" }}
                  </div>
                  <div class="terminal-line t-add">
                    {{ "+ CREATE INDEX search_idx ON products (name)" }}
                  </div>
                  <div class="terminal-line t-add">
                    {{ "+ CREATE INDEX sku_idx ON products (sku)" }}
                  </div>
                  <div class="terminal-line t-add">
                    {{ "+ CREATE TABLE orders (id, customerId, ...)" }}
                  </div>
                  <div class="terminal-line t-add">
                    {{ "+ CREATE VIEW order_stats AS SELECT ..." }}
                  </div>
                  <div class="terminal-line t-ok">Schema synced. 5 changes applied.</div>
                </div>
              </div>
              <div class="story-links">
                <a href="/sync/" class="story-link">How Sync Works</a>
                <a href="/sync/ci-cd" class="story-link">CI/CD Integration</a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ═══════════════════ 6. REST API ═══════════════════ -->
      <section class="section-story">
        <div class="section-inner">
          <div class="story-grid story-grid-reverse animate-in">
            <div class="story-copy">
              <h2 class="section-heading">REST API from one class</h2>
              <p class="story-desc">
                Writing CRUD controllers by hand is work that adds no value. Extend
                <code>AsDbController</code>, point it at a table, and get filtering, sorting,
                pagination, and search endpoints with zero boilerplate.
              </p>
              <div class="story-tags">
                <span class="story-tag">@TableController</span>
                <span class="story-tag">auto CRUD</span>
                <span class="story-tag">URL query syntax</span>
                <span class="story-tag">Moost</span>
              </div>
              <div class="story-links">
                <a href="/http/" class="story-link">HTTP Setup</a>
                <a href="/http/query-syntax" class="story-link">URL Query Syntax</a>
              </div>
            </div>
            <div class="story-code">
              <div class="code-label brand-label">controller.ts</div>
              <div class="code-block brand-block">
                <SnippetRest />
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ═══════════════════ Any Database ═══════════════════ -->
      <section class="section-adapters bg-straight">
        <div class="section-inner">
          <div class="adapters-block adapters-block-centered animate-in">
            <h2 class="section-heading section-heading-center">Any database. Same code.</h2>
            <p class="story-desc story-desc-center">
              Prototype with SQLite. Ship with PostgreSQL. Switch to MongoDB. Your schema, queries,
              and controllers stay the same — only the adapter changes.
            </p>
            <div class="adapter-grid">
              <a
                v-for="a in adapterEntries"
                :key="a.href"
                :href="a.href"
                class="adapter-card"
                :style="{ '--adapter-color': a.color }"
              >
                <div class="adapter-logo" v-html="a.logo"></div>
                <div class="adapter-name">{{ a.name }}</div>
                <div class="adapter-note">{{ a.note }}</div>
              </a>
            </div>
            <div class="story-links story-links-center" style="margin-top: 24px">
              <a href="/adapters/" class="story-link">Compare adapters</a>
              <a href="/adapters/creating-adapters" class="story-link">Build your own</a>
            </div>
          </div>
        </div>
      </section>

      <!-- ═══════════════════ AI Agent Skill ═══════════════════ -->
      <section class="section-skill">
        <div class="section-inner">
          <div class="skill-block animate-in">
            <div class="skill-head">
              <span class="skill-eyebrow">AI Agent Skill</span>
              <h2 class="section-heading section-heading-center">
                Your AI already speaks Atscript DB.
              </h2>
              <p class="story-desc story-desc-center skill-desc">
                One command teaches Claude Code, Cursor, Windsurf, and Codex the entire DB layer —
                <code>@db.*</code>, four adapters, schema sync, relations and
                <code>moost-db</code> REST.
              </p>
            </div>

            <button
              type="button"
              class="install-card"
              :class="{ copied: copiedCmd === 'npx skills add moostjs/atscript-db' }"
              @click="copyCmd('npx skills add moostjs/atscript-db')"
              aria-label="Copy install command: npx skills add moostjs/atscript-db"
            >
              <span class="install-prompt">$</span>
              <span class="install-cmd">npx skills add <strong>moostjs/atscript-db</strong></span>
              <span class="install-action" aria-hidden="true">
                <span class="install-action-icon">
                  <svg
                    v-if="copiedCmd !== 'npx skills add moostjs/atscript-db'"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <rect x="9" y="9" width="11" height="11" rx="2" />
                    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                  </svg>
                  <svg
                    v-else
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                </span>
                <span class="install-action-label">
                  {{
                    copiedCmd === "npx skills add moostjs/atscript-db" ? "Copied!" : "Click to copy"
                  }}
                </span>
              </span>
            </button>

            <ul class="install-bullets">
              <li><span class="bullet-dot"></span><code>@db.*</code> annotations &amp; types</li>
              <li>
                <span class="bullet-dot"></span>SQLite · PostgreSQL · MySQL · MongoDB adapters
              </li>
              <li><span class="bullet-dot"></span>schema sync · relations · views</li>
              <li>
                <span class="bullet-dot"></span><code>moost-db</code> REST &amp; browser client
              </li>
            </ul>

            <div class="skill-companions">
              <span class="companions-label">Companions</span>
              <div class="companions-list">
                <button
                  type="button"
                  class="companions-pill"
                  :class="{ copied: copiedCmd === 'npx skills add moostjs/atscript' }"
                  @click="copyCmd('npx skills add moostjs/atscript')"
                  aria-label="Copy: npx skills add moostjs/atscript"
                >
                  <span class="pill-tag">DSL</span>
                  <code>npx skills add moostjs/atscript</code>
                  <span class="pill-icon" aria-hidden="true">
                    <svg
                      v-if="copiedCmd !== 'npx skills add moostjs/atscript'"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <rect x="9" y="9" width="11" height="11" rx="2" />
                      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                    </svg>
                    <svg
                      v-else
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.4"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                  </span>
                </button>
                <button
                  type="button"
                  class="companions-pill"
                  :class="{ copied: copiedCmd === 'npx skills add moostjs/atscript-ui' }"
                  @click="copyCmd('npx skills add moostjs/atscript-ui')"
                  aria-label="Copy: npx skills add moostjs/atscript-ui"
                >
                  <span class="pill-tag">UI</span>
                  <code>npx skills add moostjs/atscript-ui</code>
                  <span class="pill-icon" aria-hidden="true">
                    <svg
                      v-if="copiedCmd !== 'npx skills add moostjs/atscript-ui'"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <rect x="9" y="9" width="11" height="11" rx="2" />
                      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                    </svg>
                    <svg
                      v-else
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.4"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                  </span>
                </button>
              </div>
            </div>

            <a href="https://skills.sh" class="story-link skill-link"
              >Learn about AI agent skills</a
            >
          </div>
        </div>
      </section>

      <!-- ═══════════════════ Part of the stack ═══════════════════ -->
      <section class="section-stack">
        <div class="section-inner">
          <div class="stack-block animate-in">
            <h2 class="section-heading section-heading-center">Part of a model-driven stack.</h2>
            <p class="story-desc story-desc-center">
              One <code>.as</code> file powers TypeScript types, runtime validation, DB schema, REST
              routes, forms and tables. Three sites, one source of truth.
            </p>
            <div class="stack-grid">
              <a href="https://atscript.dev" class="stack-card">
                <div class="stack-card-tag">DSL</div>
                <div class="stack-card-name">Atscript</div>
                <div class="stack-card-note">
                  Types, metadata and validation from a single <code>.as</code> model.
                </div>
                <span class="stack-card-host">atscript.dev →</span>
              </a>
              <a href="https://ui.atscript.dev" class="stack-card">
                <div class="stack-card-tag">ui</div>
                <div class="stack-card-name">Atscript UI</div>
                <div class="stack-card-note">
                  Forms, smart tables and multi-step flows — rendered from <code>.as</code>.
                </div>
                <span class="stack-card-host">ui.atscript.dev →</span>
              </a>
              <a href="https://moost.org" class="stack-card">
                <div class="stack-card-tag">runtime</div>
                <div class="stack-card-name">Moost</div>
                <div class="stack-card-note">
                  Decorator-driven framework for HTTP, CLI, WF and WS events.
                </div>
                <span class="stack-card-host">moost.org →</span>
              </a>
            </div>
          </div>
        </div>
      </section>
    </template>
  </Layout>
</template>

<style scoped>
/* ════════════════════ Layout ════════════════════ */
.section-inner {
  max-width: 1152px;
  margin: 0 auto;
}
.section-heading {
  font-size: 26px;
  font-weight: 700;
  color: var(--vp-c-text-1);
  margin-bottom: 16px;
}
@media (min-width: 640px) {
  .section-heading {
    font-size: 30px;
  }
}
.bg-diagonal {
  position: relative;
}
.bg-diagonal::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  background: var(--vp-c-bg-soft);
  clip-path: polygon(0 40px, 100% 0, 100% 100%, 0 calc(100% - 40px));
}
.bg-straight {
  position: relative;
}
.bg-straight::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  background: var(--vp-c-bg-soft);
}

/* ════════════════════ Hero ════════════════════ */
.custom-hero {
  position: relative;
  overflow: hidden;
  margin-top: calc((var(--vp-nav-height) + var(--vp-layout-top-height, 0px)) * -1);
  padding: calc(var(--vp-nav-height) + var(--vp-layout-top-height, 0px) + 48px) 24px 48px;
}
@media (min-width: 640px) {
  .custom-hero {
    padding: calc(var(--vp-nav-height) + var(--vp-layout-top-height, 0px) + 64px) 48px 64px;
  }
}
@media (min-width: 960px) {
  .custom-hero {
    padding: calc(var(--vp-nav-height) + var(--vp-layout-top-height, 0px) + 64px) 64px 64px;
  }
}
.hero-inner {
  max-width: 1152px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}
@media (min-width: 960px) {
  .hero-inner {
    flex-direction: row;
    text-align: left;
  }
}
.hero-main {
  position: relative;
  z-index: 10;
  order: 2;
  flex-grow: 1;
  flex-shrink: 0;
}
@media (min-width: 960px) {
  .hero-main {
    order: 1;
    width: calc((100% / 3) * 2);
    max-width: 592px;
  }
}
.hero-image {
  order: 1;
  margin: -76px -24px -48px;
}
@media (min-width: 640px) {
  .hero-image {
    margin: -108px -24px -48px;
  }
}
@media (min-width: 960px) {
  .hero-image {
    flex-grow: 1;
    order: 2;
    margin: 0;
    min-height: 100%;
  }
}
.image-container {
  position: relative;
  margin: 0 auto;
  width: 320px;
  height: 320px;
  isolation: isolate;
}
@media (min-width: 640px) {
  .image-container {
    width: 392px;
    height: 392px;
  }
}
@media (min-width: 960px) {
  .image-container {
    display: flex;
    justify-content: center;
    align-items: center;
    width: 100%;
    height: 100%;
    transform: translate(-32px, -32px);
  }
}
.image-src {
  position: absolute;
  top: 50%;
  left: 50%;
  max-width: 192px;
  transform: translate(-50%, -50%);
  z-index: 2;
  filter: drop-shadow(0 0 40px rgba(71, 26, 236, 0.35))
    drop-shadow(0 0 80px rgba(71, 26, 236, 0.25)) drop-shadow(0 0 120px rgba(71, 26, 236, 0.15));
}

/* ════════════════════ Hero dotted grid backdrop ════════════════════ */
.hero-dots-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-image: radial-gradient(rgba(71, 26, 236, 0.18) 1px, transparent 1.4px);
  background-size: 22px 22px;
  background-position: 0 0;
  mask-image: radial-gradient(ellipse at 50% 30%, rgba(0, 0, 0, 0.55), transparent 75%);
  -webkit-mask-image: radial-gradient(ellipse at 50% 30%, rgba(0, 0, 0, 0.55), transparent 75%);
}
:global(.dark) .hero-dots-bg {
  background-image: radial-gradient(rgba(174, 153, 252, 0.22) 1px, transparent 1.4px);
}

/* ════════════════════ Schema constellation ════════════════════ */
.constellation {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 320px;
  height: 320px;
  transform: translate(-50%, -50%);
  pointer-events: none;
  z-index: 1;
}
@media (min-width: 640px) {
  .constellation {
    width: 360px;
    height: 360px;
  }
}
@media (min-width: 960px) {
  .constellation {
    width: 380px;
    height: 380px;
  }
}
.hero-fk-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 1;
  overflow: visible;
  pointer-events: none;
}
.fk-path {
  fill: none;
  stroke: rgba(71, 26, 236, 0.32);
  stroke-width: 1.2;
  stroke-linecap: round;
  stroke-dasharray: 3 6;
}
:global(.dark) .fk-path {
  stroke: rgba(174, 153, 252, 0.4);
}
.fk-pulse {
  fill: var(--vp-c-brand-1);
  filter: drop-shadow(0 0 6px rgba(71, 26, 236, 0.65));
}
:global(.dark) .fk-pulse {
  fill: #ae99fc;
  filter: drop-shadow(0 0 6px rgba(174, 153, 252, 0.75));
}

.schema-card {
  position: absolute;
  width: 78px;
  padding: 5px 7px 7px;
  z-index: 1;
  border-radius: 7px;
  background: var(--vp-c-bg);
  border: 1px solid rgba(71, 26, 236, 0.28);
  box-shadow:
    0 4px 16px rgba(71, 26, 236, 0.12),
    0 1px 0 rgba(255, 255, 255, 0.6) inset;
  display: flex;
  flex-direction: column;
  gap: 4px;
  animation: card-float 9s ease-in-out infinite;
}
:global(.dark) .schema-card {
  background: rgba(33, 27, 53, 0.92);
  border-color: rgba(174, 153, 252, 0.35);
  box-shadow:
    0 4px 16px rgba(0, 0, 0, 0.35),
    0 1px 0 rgba(255, 255, 255, 0.04) inset;
}
.schema-card-head {
  font-family: var(--vp-font-family-mono);
  font-size: 9px;
  font-weight: 700;
  color: var(--vp-c-brand-1);
  letter-spacing: 0.04em;
  padding: 2px 0 3px;
  border-bottom: 1px dashed rgba(71, 26, 236, 0.25);
  margin-bottom: 2px;
}
:global(.dark) .schema-card-head {
  border-bottom-color: rgba(174, 153, 252, 0.3);
}
.schema-card-row {
  height: 4px;
  border-radius: 999px;
  background: linear-gradient(90deg, rgba(71, 26, 236, 0.22), rgba(43, 170, 196, 0.18));
}
:global(.dark) .schema-card-row {
  background: linear-gradient(90deg, rgba(174, 153, 252, 0.32), rgba(43, 170, 196, 0.22));
}
.r-s {
  width: 55%;
}
.r-m {
  width: 78%;
}
.r-l {
  width: 100%;
}

.schema-card-tl {
  top: 8%;
  left: 6%;
  animation-delay: 0s;
}
.schema-card-tr {
  top: 8%;
  right: 6%;
  animation-delay: -2.2s;
}
.schema-card-bl {
  bottom: 8%;
  left: 6%;
  animation-delay: -4.5s;
}
.schema-card-br {
  bottom: 8%;
  right: 6%;
  animation-delay: -6.7s;
}

@keyframes card-float {
  0%,
  100% {
    transform: translateY(0) rotate(-1deg);
  }
  50% {
    transform: translateY(-8px) rotate(1deg);
  }
}

@media (max-width: 639px) {
  .hero-fk-svg,
  .schema-card {
    display: none;
  }
}
:global(.dark) .image-src {
  filter: drop-shadow(0 0 40px rgba(174, 153, 252, 0.5))
    drop-shadow(0 0 80px rgba(174, 153, 252, 0.35)) drop-shadow(0 0 140px rgba(174, 153, 252, 0.2));
}
@media (min-width: 640px) {
  .image-src {
    max-width: 256px;
  }
}
@media (min-width: 960px) {
  .image-src {
    max-width: 320px;
  }
}
.hero-kicker {
  margin: 0 0 12px;
  color: var(--vp-c-brand-1);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.kicker-link {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.kicker-link:hover {
  text-decoration-thickness: 2px;
}
.hero-name {
  font-size: 84px;
  font-weight: 600;
  letter-spacing: -1px;
  line-height: 1.1;
  color: var(--vp-c-brand-1);
  margin-bottom: 8px;
}
@media (min-width: 640px) {
  .hero-name {
    font-size: 56px;
  }
}
@media (min-width: 960px) {
  .hero-name {
    font-size: 84px;
  }
}
.hero-text {
  font-size: 20px;
  font-weight: 700;
  color: var(--vp-c-text-1);
  line-height: 1.3;
  max-width: 600px;
  margin: 0 auto 8px;
}
@media (min-width: 640px) {
  .hero-text {
    font-size: 32px;
  }
}
@media (min-width: 960px) {
  .hero-text {
    font-size: 36px;
    margin: 0 0 8px;
  }
}
.hero-tagline {
  font-size: 16px;
  font-weight: 500;
  color: var(--vp-c-text-2);
  max-width: 520px;
  margin: 0 auto;
  line-height: 1.5;
}
@media (min-width: 640px) {
  .hero-tagline {
    font-size: 20px;
  }
}
@media (min-width: 960px) {
  .hero-tagline {
    margin: 0;
  }
}
.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  margin: -6px;
  padding-top: 28px;
}
@media (min-width: 960px) {
  .actions {
    justify-content: flex-start;
  }
}
.action {
  flex-shrink: 0;
  padding: 6px;
}

/* ════════════════════ Story Sections ════════════════════ */
.section-story {
  padding: 56px 24px;
}
@media (min-width: 640px) {
  .section-story {
    padding: 72px 48px;
  }
}
@media (min-width: 960px) {
  .section-story {
    padding: 80px 64px;
  }
}

.story-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 32px;
  align-items: start;
}
@media (min-width: 900px) {
  .story-grid {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
    gap: 40px;
  }
  .story-grid-reverse > :first-child {
    order: 2;
  }
  .story-grid-reverse > :last-child {
    order: 1;
  }
}
.story-copy {
  min-width: 0;
}

.story-desc {
  max-width: 540px;
  margin: 0 0 18px;
  font-size: 16px;
  line-height: 1.75;
  color: var(--vp-c-text-2);
}
.story-desc code {
  font-size: 14px;
  color: var(--vp-c-brand-1);
  background: rgba(71, 26, 236, 0.08);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: var(--vp-font-family-mono);
}
:global(.dark) .story-desc code {
  background: rgba(174, 153, 252, 0.12);
}

.story-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 18px;
}
.story-tag {
  display: inline-flex;
  align-items: center;
  padding: 5px 10px;
  border-radius: 999px;
  background: rgba(71, 26, 236, 0.08);
  color: var(--vp-c-brand-1);
  font-size: 12px;
  font-weight: 600;
  font-family: var(--vp-font-family-mono);
}
:global(.dark) .story-tag {
  background: rgba(174, 153, 252, 0.12);
}

.story-links {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 14px;
}
.story-link {
  display: inline-flex;
  align-items: center;
  color: var(--vp-c-brand-1);
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
}
.story-link::after {
  content: "->";
  margin-left: 8px;
  font-size: 12px;
}
.story-link:hover {
  text-decoration: underline;
}

.story-code {
  min-width: 0;
}

/* ════════════════════ Code Blocks ════════════════════ */
.code-label {
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.5px;
  border-radius: 12px 12px 0 0;
}
.brand-label {
  background: rgba(71, 26, 236, 0.12);
  color: var(--vp-c-brand-1);
}
:global(.dark) .brand-label {
  background: rgba(174, 153, 252, 0.12);
}
.code-block {
  border-radius: 0 0 12px 12px;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  border-top: none;
  background: var(--vp-c-bg);
}
:global(.dark) .code-block {
  border-color: rgba(255, 255, 255, 0.06);
}
.brand-block {
  box-shadow:
    0 0 40px rgba(71, 26, 236, 0.1),
    0 0 80px rgba(71, 26, 236, 0.05);
  border-color: rgba(71, 26, 236, 0.2);
}
:global(.dark) .brand-block {
  box-shadow:
    0 0 40px rgba(174, 153, 252, 0.15),
    0 0 80px rgba(174, 153, 252, 0.08);
  border-color: rgba(174, 153, 252, 0.25);
}
.code-block :deep(div[class*="language-"]) {
  margin: 0 !important;
  border-radius: 0;
  background: var(--vp-c-bg) !important;
}
.code-block :deep(button.copy),
.code-block :deep(span.lang),
.code-block :deep(.line-numbers-wrapper) {
  display: none !important;
}
.code-block :deep(pre) {
  padding: 0 !important;
  margin: 0 !important;
  overflow-x: auto;
}
.code-block :deep(code) {
  display: block;
  width: fit-content;
  min-width: 100%;
  padding: 8px 20px;
  font-size: 13px;
}
.code-block :deep(.file-sep) {
  padding: 4px 16px;
  font-size: 12px;
  font-family: var(--vp-font-family-mono);
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-alt);
  border-top: 1px solid var(--vp-c-divider);
}
:global(.dark) .code-block :deep(.file-sep) {
  border-top-color: rgba(255, 255, 255, 0.06);
}
.code-block :deep(.file-sep:first-child) {
  border-top: none;
}

/* ════════════════════ Terminal ════════════════════ */
.sync-terminal {
  margin: 24px 0 8px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  background: #1a1a2e;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
}
:global(.dark) .sync-terminal {
  background: #0d0d1a;
  border-color: rgba(255, 255, 255, 0.06);
}
.terminal-bar {
  display: flex;
  gap: 6px;
  padding: 10px 14px;
  background: rgba(255, 255, 255, 0.04);
}
.terminal-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.15);
}
.terminal-body {
  padding: 12px 16px;
}
.terminal-line {
  color: rgba(255, 255, 255, 0.7);
  line-height: 1.8;
  white-space: pre;
}
.t-prompt {
  color: #ae99fc;
  font-weight: 700;
  margin-right: 8px;
}
.t-muted {
  color: rgba(255, 255, 255, 0.4);
}
.t-hash {
  color: #ae99fc;
}
.t-add {
  color: #7ee787;
}
.t-ok {
  color: #58d68d;
  font-weight: 600;
}

/* ════════════════════ Adapters ════════════════════ */
.section-adapters {
  padding: 56px 24px 48px;
  margin-bottom: 0;
}
@media (min-width: 640px) {
  .section-adapters {
    padding: 72px 48px 64px;
  }
}
@media (min-width: 960px) {
  .section-adapters {
    padding: 80px 64px 80px;
  }
}
.adapters-block {
  max-width: 860px;
}
.adapters-block-centered {
  margin: 0 auto;
  text-align: center;
}
.story-links-center {
  justify-content: center;
}

.adapter-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 24px;
}
@media (min-width: 640px) {
  .adapter-grid {
    grid-template-columns: repeat(4, 1fr);
  }
}
.adapter-card {
  padding: 22px 16px 18px;
  border-radius: 12px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  text-decoration: none;
  color: inherit;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  transition:
    border-color 0.25s ease,
    transform 0.25s ease,
    box-shadow 0.25s ease;
}
.adapter-card:hover {
  border-color: var(--adapter-color, var(--vp-c-brand-1));
  transform: translateY(-2px);
  box-shadow: 0 4px 18px
    color-mix(in srgb, var(--adapter-color, var(--vp-c-brand-1)) 18%, transparent);
}
.adapter-logo {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 4px;
  color: var(--adapter-color, var(--vp-c-brand-1));
  filter: grayscale(1);
  opacity: 0.55;
  transition:
    transform 0.3s ease,
    filter 0.3s ease,
    opacity 0.3s ease;
}
.adapter-card:hover .adapter-logo {
  transform: translateY(-2px) scale(1.05);
  filter: grayscale(0);
  opacity: 1;
}
.adapter-logo :deep(svg) {
  width: 100%;
  height: 100%;
}
.adapter-name {
  font-size: 15px;
  font-weight: 700;
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  margin-bottom: 2px;
}
.adapter-card:hover .adapter-name {
  color: var(--adapter-color, var(--vp-c-brand-1));
}
.adapter-note {
  font-size: 12px;
  color: var(--vp-c-text-3);
}

/* ════════════════════ AI Agent Skill section ════════════════════ */
.section-skill {
  position: relative;
  padding: 64px 24px 72px;
  background:
    radial-gradient(
      ellipse at 50% 0%,
      color-mix(in srgb, var(--vp-c-brand-1) 8%, transparent),
      transparent 60%
    ),
    var(--vp-c-bg);
}
:global(.dark) .section-skill {
  background:
    radial-gradient(
      ellipse at 50% 0%,
      color-mix(in srgb, var(--vp-c-brand-1) 14%, transparent),
      transparent 65%
    ),
    var(--vp-c-bg);
}
@media (min-width: 640px) {
  .section-skill {
    padding: 80px 48px 88px;
  }
}
@media (min-width: 960px) {
  .section-skill {
    padding: 88px 64px 96px;
  }
}
.skill-block {
  max-width: 760px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.skill-head {
  text-align: center;
  margin-bottom: 28px;
}
.skill-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
  background: rgba(71, 26, 236, 0.1);
  padding: 5px 10px;
  border-radius: 999px;
  margin-bottom: 14px;
}
:global(.dark) .skill-eyebrow {
  background: rgba(174, 153, 252, 0.16);
}
.skill-desc {
  margin-bottom: 0;
}
.skill-desc code {
  font-size: 13px;
  color: var(--vp-c-brand-1);
  background: rgba(71, 26, 236, 0.08);
  padding: 1px 6px;
  border-radius: 5px;
  font-family: var(--vp-font-family-mono);
}
:global(.dark) .skill-desc code {
  background: rgba(174, 153, 252, 0.14);
}

/* ── Prominent install command card ── */
.install-card {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  max-width: 520px;
  padding: 12px 12px 12px 18px;
  border-radius: 12px;
  border: 1px solid rgba(71, 26, 236, 0.28);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  cursor: pointer;
  text-align: left;
  box-shadow:
    0 12px 32px rgba(71, 26, 236, 0.12),
    0 0 0 4px rgba(71, 26, 236, 0.05);
  transition:
    transform 0.18s ease,
    border-color 0.18s ease,
    box-shadow 0.18s ease,
    background 0.18s ease;
}
:global(.dark) .install-card {
  background: rgba(255, 255, 255, 0.02);
  border-color: rgba(174, 153, 252, 0.32);
  box-shadow:
    0 12px 32px rgba(0, 0, 0, 0.4),
    0 0 0 4px rgba(174, 153, 252, 0.06);
}
.install-card:hover {
  transform: translateY(-2px);
  border-color: var(--vp-c-brand-1);
  box-shadow:
    0 18px 40px rgba(71, 26, 236, 0.18),
    0 0 0 4px rgba(71, 26, 236, 0.08);
}
.install-card.copied {
  border-color: #18a674;
  box-shadow:
    0 12px 32px rgba(24, 166, 116, 0.18),
    0 0 0 4px rgba(24, 166, 116, 0.08);
}
.install-prompt {
  font-size: 17px;
  font-weight: 800;
  color: var(--vp-c-brand-1);
  line-height: 1;
}
.install-cmd {
  flex: 1;
  font-size: 14px;
  letter-spacing: -0.1px;
  color: var(--vp-c-text-1);
  overflow-x: auto;
  white-space: nowrap;
}
.install-cmd strong {
  color: var(--vp-c-brand-1);
  font-weight: 700;
}
@media (min-width: 640px) {
  .install-cmd {
    font-size: 15px;
  }
}
.install-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px 6px 8px;
  border-radius: 999px;
  background: rgba(71, 26, 236, 0.08);
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-sans);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
  white-space: nowrap;
  transition:
    background 0.2s ease,
    color 0.2s ease;
}
:global(.dark) .install-action {
  background: rgba(174, 153, 252, 0.14);
}
.install-card.copied .install-action {
  background: rgba(24, 166, 116, 0.12);
  color: #18a674;
}
.install-action-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
}
.install-action-icon svg {
  width: 13px;
  height: 13px;
}
.install-action {
  font-size: 11.5px;
}
@media (max-width: 520px) {
  .install-action-label {
    display: none;
  }
}

/* ── Accurate bullet list ── */
.install-bullets {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px 22px;
  margin: 18px 0 6px;
  padding: 0;
  list-style: none;
}
.install-bullets li {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.install-bullets li code {
  font-size: 12.5px;
  color: var(--vp-c-brand-1);
  background: rgba(71, 26, 236, 0.08);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: var(--vp-font-family-mono);
}
:global(.dark) .install-bullets li code {
  background: rgba(174, 153, 252, 0.14);
}
.bullet-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--vp-c-brand-1);
  flex-shrink: 0;
  opacity: 0.7;
}

/* ── Companions ── */
.skill-companions {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  margin: 28px 0 8px;
  width: 100%;
}
.companions-label {
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--vp-c-text-3);
}
.companions-list {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  width: 100%;
}
.companions-pill {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 6px 10px 6px 6px;
  border-radius: 10px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-2);
  font: inherit;
  cursor: pointer;
  text-align: left;
  transition:
    border-color 0.2s ease,
    color 0.2s ease,
    background 0.2s ease,
    transform 0.15s ease;
}
.companions-pill:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-text-1);
  transform: translateY(-1px);
}
.companions-pill:active {
  transform: translateY(0);
}
.companions-pill.copied {
  border-color: #18a674;
  background: color-mix(in srgb, #18a674 6%, transparent);
}
:global(.dark) .companions-pill {
  border-color: rgba(255, 255, 255, 0.1);
}
.pill-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 22px;
  padding: 0 8px;
  border-radius: 6px;
  background: rgba(71, 26, 236, 0.1);
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.06em;
}
:global(.dark) .pill-tag {
  background: rgba(174, 153, 252, 0.18);
}
.companions-pill code {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  background: transparent;
  padding: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pill-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  color: var(--vp-c-text-3);
  background: transparent;
  transition:
    color 0.2s ease,
    background 0.2s ease;
}
.pill-icon svg {
  width: 14px;
  height: 14px;
}
.companions-pill:hover .pill-icon {
  color: var(--vp-c-brand-1);
  background: rgba(71, 26, 236, 0.08);
}
.companions-pill.copied .pill-icon {
  color: #18a674;
  background: rgba(24, 166, 116, 0.12);
}

.skill-link {
  margin-top: 18px;
}

/* ════════════════════ Stack (ecosystem) ════════════════════ */
.section-heading-center {
  text-align: center;
}
.story-desc-center {
  text-align: center;
  margin-left: auto;
  margin-right: auto;
}
.section-stack {
  padding: 64px 24px 96px;
}
@media (min-width: 640px) {
  .section-stack {
    padding: 80px 48px 112px;
  }
}
@media (min-width: 960px) {
  .section-stack {
    padding: 88px 64px 128px;
  }
}
.stack-block {
  max-width: 960px;
  margin: 0 auto;
}
.stack-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
  margin-top: 28px;
}
@media (min-width: 720px) {
  .stack-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}
.stack-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 22px 22px 18px;
  border-radius: 14px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  text-decoration: none;
  color: inherit;
  transition:
    border-color 0.25s ease,
    transform 0.25s ease,
    box-shadow 0.25s ease;
}
.stack-card:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-2px);
  box-shadow: 0 6px 24px rgba(71, 26, 236, 0.12);
}
:global(.dark) .stack-card {
  border-color: rgba(255, 255, 255, 0.06);
}
:global(.dark) .stack-card:hover {
  box-shadow: 0 6px 24px rgba(174, 153, 252, 0.16);
}
.stack-card-tag {
  display: inline-block;
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
  background: rgba(71, 26, 236, 0.08);
  padding: 3px 8px;
  border-radius: 999px;
  width: fit-content;
}
:global(.dark) .stack-card-tag {
  background: rgba(174, 153, 252, 0.14);
}
.stack-card-name {
  font-size: 20px;
  font-weight: 700;
  color: var(--vp-c-text-1);
}
.stack-card-note {
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}
.stack-card-note code {
  font-size: 12px;
  color: var(--vp-c-brand-1);
  background: rgba(71, 26, 236, 0.08);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: var(--vp-font-family-mono);
}
:global(.dark) .stack-card-note code {
  background: rgba(174, 153, 252, 0.12);
}
.stack-card-host {
  margin-top: 6px;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
}

/* ════════════════════ Scroll Animations ════════════════════ */
.animate-in {
  opacity: 0;
  transform: translateY(24px);
  transition:
    opacity 0.6s ease,
    transform 0.6s ease;
}
.animate-in.visible {
  opacity: 1;
  transform: translateY(0);
}
</style>
