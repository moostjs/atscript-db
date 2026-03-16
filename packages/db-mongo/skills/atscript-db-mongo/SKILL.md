---
name: atscript-db-mongo
description: Use this skill when working with @atscript/db-mongo — to define MongoDB collections with @db.table and @db.mongo.collection, create indexes with @db.index.plain/@db.index.unique/@db.mongo.index.text, configure Atlas Search with @db.mongo.search.*, control patch strategies with @db.mongo.patch.strategy, use AsCollection for CRUD operations (insert/replace/update/syncIndexes), validate data with createValidator, or configure MongoPlugin in atscript.config.
---

# @atscript/db-mongo

MongoDB metadata extension for Atscript. Defines annotations for collections, indexes, search, and patch strategies, plus runtime classes (`AsCollection`, `AsMongo`) with built-in validation, filtering, querying, and writing.

## How to use this skill

Read the domain file that matches the task. Do not load all files — only what you need.

| Domain                     | File                             | Load when...                                                                                             |
| -------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Core setup & plugin config | [core.md](core.md)               | Installing the plugin, configuring atscript.config, understanding the plugin architecture                |
| Annotations reference      | [annotations.md](annotations.md) | Writing .as files with database and MongoDB annotations, understanding annotation arguments              |
| Collections & CRUD         | [collections.md](collections.md) | Using AsCollection/AsMongo for insert, replace, update, query, or sync indexes                           |
| Patch strategies           | [patches.md](patches.md)         | Working with @db.mongo.patch.strategy, array patch operations ($insert/$upsert/$update/$remove/$replace) |

## Quick reference

```atscript
@db.table 'users'
@db.mongo.collection
export interface User {
    @db.index.unique 'email_idx'
    email: string.email

    @db.mongo.index.text 5
    name: string

    @db.index.plain 'status_idx'
    isActive: boolean
}
```

```typescript
import { AsMongo } from "@atscript/db-mongo";
import { User } from "./user.as";

const asMongo = new AsMongo("mongodb://localhost:27017/mydb");
const users = asMongo.getCollection(User);
await users.insert({ email: "a@b.com", name: "Alice", isActive: true });
```
