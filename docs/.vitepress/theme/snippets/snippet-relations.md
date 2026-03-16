<div class="file-sep">schema/order.as</div>

```atscript
import { Customer } from './customer'
import { OrderItem } from './order-item'

@db.table 'orders'
export interface Order {
  @meta.id
  @db.default.uuid
  id: string

  @db.rel.FK
  @db.rel.onDelete 'cascade'
  customerId: Customer.id

  // navigate to parent
  @db.rel.to Customer 'customerId'
  customer: Customer

  // navigate to children
  @db.rel.from OrderItem.orderId
  items: OrderItem[]

  total: number
  createdAt: number.timestamp.created
}
```
