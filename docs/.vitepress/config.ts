import { defineConfig } from "vitepress";
import llmstxtPlugin from "vitepress-plugin-llmstxt";

const atscriptGrammar = {
  name: "atscript",
  scopeName: "source.atscript",
  fileTypes: ["atscript", "as"],
  patterns: [
    { include: "#annotation-with-args" },
    { include: "#annotations" },
    { include: "#comments" },
    { include: "#strings" },
    { include: "#property-names" },
    { include: "#import-statement" },
    { include: "#keywords" },
    { include: "#numbers" },
    { include: "#operators" },
    { include: "#punctuation" },
    { include: "#global-types" },
  ],
  repository: {
    comments: {
      patterns: [
        { name: "comment.line.double-slash.atscript", match: "//.*$" },
        {
          name: "comment.block.atscript",
          begin: "/\\*",
          end: "\\*/",
          patterns: [
            {
              match: "\\*/",
              name: "invalid.illegal.stray.end-of-comment.atscript",
            },
          ],
        },
      ],
    },
    strings: {
      patterns: [{ match: "'([^']*)'|\"([^\"]*)\"", name: "string.quoted.atscript" }],
    },
    "import-statement": {
      patterns: [
        {
          name: "meta.import.statement",
          begin: "(?<![A-Za-z0-9_$])\\bimport\\b(?!\\s*[:=])",
          beginCaptures: {
            "0": { name: "keyword.control.import.atscript" },
          },
          end: "(?=;|$)",
          patterns: [
            { match: "\\bfrom\\b", name: "keyword.control.from.atscript" },
            {
              begin: "\\{",
              beginCaptures: { "0": { name: "punctuation.section.braces" } },
              end: "\\}",
              endCaptures: { "0": { name: "punctuation.section.braces" } },
              patterns: [
                {
                  name: "entity.name.type.atscript",
                  match: "\\b[A-Za-z_$][A-Za-z0-9_$]*\\b",
                },
              ],
            },
            {
              match: "'([^']*)'|\"([^\"]*)\"",
              name: "string.quoted.import.atscript",
            },
          ],
        },
      ],
    },
    keywords: {
      patterns: [
        {
          match: "(?<![A-Za-z0-9_$])\\bexport\\b(?!\\s*[:=])",
          name: "keyword.control.export.atscript",
        },
        {
          match: "(\\b(?:type|interface)\\b)\\s+([A-Za-z_][A-Za-z0-9_]*)",
          captures: {
            "1": { name: "storage.type.atscript" },
            "2": { name: "entity.name.type.atscript" },
          },
        },
        {
          match:
            "(\\bannotate\\b)\\s+([A-Za-z_][A-Za-z0-9_]*)(?:\\s+(as)\\s+([A-Za-z_][A-Za-z0-9_]*))?",
          captures: {
            "1": { name: "storage.type.atscript" },
            "2": { name: "entity.name.type.atscript" },
            "3": { name: "keyword.control.as.atscript" },
            "4": { name: "entity.name.type.atscript" },
          },
        },
      ],
    },
    numbers: {
      patterns: [{ name: "constant.numeric.atscript", match: "\\b\\d+(\\.\\d+)?\\b" }],
    },
    operators: {
      patterns: [{ name: "keyword.operator.atscript", match: "[|&=?]" }],
    },
    annotations: {
      patterns: [{ name: "keyword.control.at-rule.atscript", match: "@[A-Za-z0-9_.]+" }],
    },
    "annotation-with-args": {
      patterns: [
        {
          begin: "(@[A-Za-z0-9_.]+)",
          beginCaptures: {
            "1": { name: "keyword.control.at-rule.atscript" },
          },
          end: "(?=$|\\n|\\r|;)",
          patterns: [
            { name: "constant.numeric.atscript", match: "\\b\\d+(\\.\\d+)?\\b" },
            {
              name: "string.quoted.single.atscript",
              begin: "'",
              end: "(?:'|\\n)",
              patterns: [{ match: "\\\\.", name: "constant.character.escape.atscript" }],
            },
            {
              name: "string.quoted.double.atscript",
              begin: '"',
              end: '(?:"|\\n)',
              patterns: [{ match: "\\\\.", name: "constant.character.escape.atscript" }],
            },
            {
              name: "constant.language.boolean.atscript",
              match: "\\b(?:true|false|undefined|null)\\b",
            },
          ],
        },
      ],
    },
    punctuation: {
      patterns: [
        { name: "punctuation.separator.comma.atscript", match: "," },
        { name: "punctuation.terminator.statement.atscript", match: ";" },
        { name: "punctuation.separator.key-value.atscript", match: ":" },
        { name: "punctuation.section.parens.begin.atscript", match: "\\(" },
        { name: "punctuation.section.parens.end.atscript", match: "\\)" },
        { name: "punctuation.section.braces.begin.atscript", match: "\\{" },
        { name: "punctuation.section.braces.end.atscript", match: "\\}" },
        { name: "punctuation.section.brackets.begin.atscript", match: "\\[" },
        { name: "punctuation.section.brackets.end.atscript", match: "\\]" },
      ],
    },
    "global-types": {
      patterns: [
        {
          name: "support.type.primitive.atscript",
          match:
            "\\b(?:number|string|boolean|void|undefined|null|never|any|unknown|bigint|symbol)\\b(?!\\s*:)",
        },
        {
          name: "support.type.semantic.atscript",
          match: "\\b(string|number|boolean|mongo)\\.(\\w+)\\b",
          captures: {
            "1": { name: "support.type.primitive.atscript" },
            "2": { name: "support.type.semantic.atscript" },
          },
        },
      ],
    },
    "property-names": {
      patterns: [
        {
          name: "variable.other.property.atscript",
          match: "\\b([A-Za-z_$][A-Za-z0-9_$]*)\\b(?=\\s*:)",
        },
        {
          name: "variable.other.property.optional.atscript",
          match: "\\b([A-Za-z_$][A-Za-z0-9_$]*)\\b(?=\\?\\s*:)",
        },
      ],
    },
  },
};

const guideSidebar = [
  {
    text: "Getting Started",
    items: [
      { text: "Overview", link: "/guide/" },
      { text: "Quick Start", link: "/guide/quick-start" },
      { text: "Setup", link: "/guide/setup" },
    ],
  },
];

const adaptersSidebar = [
  {
    text: "Adapters",
    items: [
      { text: "Overview & Comparison", link: "/adapters/" },
      { text: "PostgreSQL", link: "/adapters/postgresql" },
      { text: "SQLite", link: "/adapters/sqlite" },
      { text: "MongoDB", link: "/adapters/mongodb" },
      { text: "MySQL", link: "/adapters/mysql" },
      { text: "Creating Custom Adapters", link: "/adapters/creating-adapters" },
    ],
  },
];

const schemaApiSidebar = [
  {
    text: "Schema",
    items: [
      { text: "Tables & Fields", link: "/api/tables" },
      { text: "Storage & Nested Objects", link: "/api/storage" },
      { text: "Defaults & Generated Values", link: "/api/defaults" },
      { text: "Indexes & Constraints", link: "/api/indexes" },
      { text: "Foreign Keys", link: "/relations/" },
      { text: "Navigation Properties", link: "/relations/navigation" },
      { text: "Referential Actions", link: "/relations/referential-actions" },
      { text: "Defining Views", link: "/views/" },
      { text: "View Types", link: "/views/view-types" },
      { text: "Aggregation Annotations", link: "/views/aggregations" },
      { text: "Aggregation Views", link: "/views/aggregation-views" },
      { text: "Text Search", link: "/search/" },
      { text: "Vector Search", link: "/search/vector-search" },
    ],
  },
  {
    text: "API",
    items: [
      { text: "CRUD Operations", link: "/api/crud" },
      { text: "Queries & Filters", link: "/api/queries" },
      { text: "Update & Patch", link: "/api/update-patch" },
      { text: "Transactions", link: "/api/transactions" },
      { text: "Loading Relations", link: "/relations/loading" },
      { text: "Deep Operations", link: "/relations/deep-operations" },
      { text: "Relational Patches", link: "/relations/patches" },
      { text: "Querying Views", link: "/views/querying-views" },
    ],
  },
  {
    text: "Reference",
    items: [{ text: "Annotations Reference", link: "/adapters/annotations" }],
  },
];

const syncSidebar = [
  {
    text: "Schema Sync",
    items: [
      { text: "How Sync Works", link: "/sync/" },
      { text: "CLI", link: "/sync/cli" },
      { text: "Configuration", link: "/sync/configuration" },
      { text: "What Gets Synced", link: "/sync/what-gets-synced" },
      { text: "Programmatic API", link: "/sync/programmatic" },
      { text: "CI/CD Integration", link: "/sync/ci-cd" },
    ],
  },
];

const httpSidebar = [
  {
    text: "HTTP API",
    items: [
      { text: "Setup", link: "/http/" },
      { text: "CRUD Endpoints", link: "/http/crud" },
      { text: "URL Query Syntax", link: "/http/query-syntax" },
      { text: "Relations & Search", link: "/http/advanced" },
      { text: "Customization", link: "/http/customization" },
    ],
  },
];

export default defineConfig({
  title: "Atscript DB",
  description:
    "Database adapters and query layer for Atscript — define your models once, get type-safe CRUD for any database",
  lang: "en-US",
  lastUpdated: true,
  cleanUrls: true,

  vite: {
    plugins: [
      llmstxtPlugin({
        hostname: "db.atscript.dev",
      }),
    ],
  },

  head: [
    ["link", { rel: "icon", href: "/logo.svg" }],
    ["meta", { name: "theme-color", content: "#471AEC" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "Atscript DB" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "Database adapters and query layer for Atscript — define your models once, get type-safe CRUD for any database",
      },
    ],
  ],

  markdown: {
    theme: { light: "github-light", dark: "github-dark" },
    lineNumbers: true,
    languages: ["typescript", "javascript", "json", "bash", atscriptGrammar as any],
  },

  themeConfig: {
    logo: "/logo.svg",
    siteTitle: "Atscript DB",

    nav: [
      { text: "Guide", link: "/guide/quick-start" },
      { text: "Adapters", link: "/adapters/" },
      { text: "API & Schema", link: "/api/tables" },
      { text: "Schema Sync", link: "/sync/" },
      { text: "HTTP API", link: "/http/" },
    ],

    sidebar: {
      "/guide/": guideSidebar,
      "/adapters/": adaptersSidebar,
      "/api/": schemaApiSidebar,
      "/relations/": schemaApiSidebar,
      "/views/": schemaApiSidebar,
      "/search/": schemaApiSidebar,
      "/sync/": syncSidebar,
      "/http/": httpSidebar,
    },

    socialLinks: [{ icon: "github", link: "https://github.com/moostjs/atscript-db" }],

    search: {
      provider: "local",
    },

    editLink: {
      pattern: "https://github.com/moostjs/atscript-db/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2025-present Artem Maltsev",
    },
  },
});
