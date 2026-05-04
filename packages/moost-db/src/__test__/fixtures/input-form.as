// Fixture for InputForm tests — minimal `.as` interfaces used as form types
// on action params. Not tables — just shapes the `input` field of the action
// envelope is validated against.

export interface CommentForm {
    note: string

    visibility?: 'public' | 'internal'
}

export interface AmountForm {
    amount: number

    currency: string
}
