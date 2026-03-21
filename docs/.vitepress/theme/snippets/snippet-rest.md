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
GET    /products/query    # list, filter, sort, search
GET    /products/pages    # paginated results
GET    /products/one/:id  # read one
GET    /products/meta     # table metadata
POST   /products          # create
PUT    /products          # replace
PATCH  /products          # partial update
DELETE /products/:id      # delete
```
