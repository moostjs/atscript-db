import { User } from './stored'

@db.view 'adult_users'
@db.view.for User
@db.view.filter `User.age >= 18`
export interface AdultUser {
    id: User.id
    name: User.name
}
