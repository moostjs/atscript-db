export * from "./lib";
// NOTE: the build-time plugin (MongoPlugin) is deliberately NOT re-exported here.
// It lives on the dedicated './plugin' subpath only: the plugin imports
// @atscript/core (the compiler, which carries rolldown + its native binding),
// so re-exporting it from this RUNTIME entry drags the whole compiler into
// every consumer's server bundle — and crashes prod containers that lack the
// platform-specific @rolldown/binding-* package at runtime.
