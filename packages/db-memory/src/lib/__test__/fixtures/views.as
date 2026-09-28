import { User } from './stored'

@db.view 'adult_users'
@db.view.for User
@db.view.filter `User.age >= 18`
export interface AdultUser {
    id: User.id
    name: User.name
}

/** A table under the view's name — for the table-vs-view refusals. */
@db.table 'adult_users'
export interface AdultUsersTable {
    @meta.id
    id: string
}

@db.table 'user_notes'
export interface UserNote {
    @meta.id
    id: string

    @db.rel.FK
    userId: User.id
}
