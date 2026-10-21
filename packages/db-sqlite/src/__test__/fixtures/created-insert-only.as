// `number.timestamp.created` is insert-only (created-insert-only.spec.ts). Since 0.1.165.

@db.table 'cio_notes'
export interface CioNote {
    @meta.id
    id: number.int

    title: string

    createdAt: number.timestamp.created

    updatedAt?: number.timestamp.updated
}
