@db.table 'flatten-test'
@db.mongo.collection
export interface FlattenTest {
    level0: string
    nested: {
        level1: string
        array1: {
            level2: string
            array2: {
                level3: string
            }[]
        }[]
    }
    array0: {
        level1: string
    }[]
    complexArray: {
        field1: string
    } | {
        field1: number
        field2: string
    }[]
}