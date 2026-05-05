@db.table "multi_unit_products"
export interface MultiUnitProduct {
    @meta.id
    @db.default.increment
    id: number

    @db.column.dimension
    category: string

    @db.column.dimension
    unit: string

    @db.column.measure
    @db.unit.ref 'unit'
    weight: decimal

    name: string
}

@db.table "single_unit_metrics"
export interface SingleUnitMetric {
    @meta.id
    @db.default.increment
    id: number

    @db.column.dimension
    host: string

    @db.column.measure
    @db.unit 'qps'
    rate: number
}
