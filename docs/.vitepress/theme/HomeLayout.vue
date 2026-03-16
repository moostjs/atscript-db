<script setup>
import { onMounted, nextTick, watch } from "vue";
// oxlint-disable-next-line import/named -- vitepress re-exports these
import { useData, useRoute } from "vitepress";
import DefaultTheme from "vitepress/theme";
import VPButton from "vitepress/dist/client/theme-default/components/VPButton.vue";
import SnippetTable from "./snippets/snippet-table.md";
import SnippetRelations from "./snippets/snippet-relations.md";
import SnippetView from "./snippets/snippet-view.md";
import SnippetCrud from "./snippets/snippet-crud.md";
import SnippetRest from "./snippets/snippet-rest.md";

const { Layout } = DefaultTheme;
const { frontmatter } = useData();
const route = useRoute();

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
                    Schema hash: <span class="t-hash">a7f3c912</span> (changed)
                  </div>
                  <div class="terminal-line t-muted">Acquiring lock...</div>
                  <div class="terminal-line t-add">
                    + CREATE TABLE products (id, name, sku, ...)
                  </div>
                  <div class="terminal-line t-add">
                    + CREATE INDEX search_idx ON products (name)
                  </div>
                  <div class="terminal-line t-add">+ CREATE INDEX sku_idx ON products (sku)</div>
                  <div class="terminal-line t-add">+ CREATE TABLE orders (id, customerId, ...)</div>
                  <div class="terminal-line t-add">+ CREATE VIEW order_stats AS SELECT ...</div>
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
          <div class="adapters-block animate-in">
            <h2 class="section-heading">Any database. Same code.</h2>
            <p class="story-desc">
              Prototype with SQLite. Ship with PostgreSQL. Switch to MongoDB. Your schema, queries,
              and controllers stay the same — only the adapter changes.
            </p>
            <div class="adapter-grid">
              <a href="/adapters/sqlite" class="adapter-card">
                <div class="adapter-name">SQLite</div>
                <div class="adapter-note">Zero-config, embedded</div>
              </a>
              <a href="/adapters/postgresql" class="adapter-card">
                <div class="adapter-name">PostgreSQL</div>
                <div class="adapter-note">Full-featured, production-ready</div>
              </a>
              <a href="/adapters/mysql" class="adapter-card">
                <div class="adapter-name">MySQL</div>
                <div class="adapter-note">Widely deployed, familiar</div>
              </a>
              <a href="/adapters/mongodb" class="adapter-card">
                <div class="adapter-name">MongoDB</div>
                <div class="adapter-note">Document store, flexible</div>
              </a>
            </div>
            <div class="story-links" style="margin-top: 24px">
              <a href="/adapters/" class="story-link">Compare adapters</a>
              <a href="/adapters/creating-adapters" class="story-link">Build your own</a>
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
  filter: drop-shadow(0 0 40px rgba(71, 26, 236, 0.35))
    drop-shadow(0 0 80px rgba(71, 26, 236, 0.25)) drop-shadow(0 0 120px rgba(71, 26, 236, 0.15));
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
  padding: 20px 16px;
  border-radius: 12px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  text-decoration: none;
  color: inherit;
  text-align: center;
  transition:
    border-color 0.25s ease,
    transform 0.25s ease,
    box-shadow 0.25s ease;
}
.adapter-card:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-2px);
  box-shadow: 0 4px 16px rgba(71, 26, 236, 0.1);
}
:global(.dark) .adapter-card:hover {
  box-shadow: 0 4px 16px rgba(174, 153, 252, 0.12);
}
.adapter-name {
  font-size: 15px;
  font-weight: 700;
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  margin-bottom: 4px;
}
.adapter-note {
  font-size: 12px;
  color: var(--vp-c-text-3);
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
