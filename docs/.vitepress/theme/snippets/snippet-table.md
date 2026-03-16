<div class="file-sep">schema/product.as</div>

```atscript
@db.table 'products'
export interface Product {
  @meta.id
  @db.default.increment
  id: number

  @db.index.fulltext 'search_idx', 3
  name: string

  description?: string

  @db.index.unique 'sku_idx'
  sku: string

  price: number

  @db.default 'active'
  status: 'active' | 'archived' | 'draft'

  createdAt: number.timestamp.created
}
```
