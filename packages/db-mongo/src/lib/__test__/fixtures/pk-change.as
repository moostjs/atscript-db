// Fixture for pk-change-server.spec.ts — a surrogate key replaced by a
// composite one, the old key field removed in the same sync.

@db.table 'pk_enrollments'
export interface EnrollmentBefore {
    @meta.id
    @db.default.increment
    id: number

    studentId: number
    courseId: number

    grade?: string
}

@db.table 'pk_enrollments'
export interface EnrollmentAfter {
    @meta.id
    studentId: number

    @meta.id
    courseId: number

    grade?: string
}
