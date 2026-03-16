<div class="file-sep">controller.ts</div>

```typescript
import { AsDbController, TableController } from "@atscript/moost-db";
import { productsTable } from "./db";
import { Product } from "./schema/product.as";

@TableController(productsTable)
export class ProductController extends AsDbController<typeof Product> {}
// GET, POST, PUT, PATCH, DELETE — ready.
```

<div class="file-sep">endpoints</div>

```bash
GET    /products          # list, filter, sort, paginate
GET    /products/:id      # read one
POST   /products          # create
PUT    /products/:id      # replace
PATCH  /products/:id      # partial update
DELETE /products/:id      # delete
GET    /products/search   # full-text search
```
