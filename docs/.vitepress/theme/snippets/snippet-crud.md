<div class="file-sep">usage.ts</div>

```typescript
import { Product } from "./schema/product.as";

const products = db.getTable(Product);

// insert
await products.insertOne({
  name: "Wireless Keyboard",
  sku: "KB-200",
  price: 79.99,
});

// query with filters and pagination
const results = await products.findMany({
  filter: { status: "active", price: { $lte: 100 } },
  controls: { $sort: { price: 1 }, $limit: 20 },
});

// full-text search
const matches = await products.search("wireless keyboard");
```
