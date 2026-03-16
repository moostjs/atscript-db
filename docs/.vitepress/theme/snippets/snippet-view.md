<div class="file-sep">schema/order-stats.as</div>

```atscript
import { Order } from './order'
import { Customer } from './customer'

@db.view 'order_stats'
@db.view.for Order
@db.view.joins Customer, `Customer.id = Order.customerId`
@db.view.filter `Order.status = 'completed'`
export interface OrderStats {
  // GROUP BY column
  region: Customer.region

  @db.agg.sum "total"
  revenue: number

  @db.agg.count
  orderCount: number

  @db.agg.avg "total"
  avgOrder: number
}
```
