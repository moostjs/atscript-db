// `number.timestamp.created` is insert-only (created-insert-only.spec.ts). Since 0.1.165.

@db.table 'cio_notes'
@db.mongo.collection
export interface CioNote {
    @meta.id
    _id: string

    title: string

    createdAt: number.timestamp.created
}
