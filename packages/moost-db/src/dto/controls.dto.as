export interface QueryControlsDto {
    $skip?: number.int.positive
    $limit?: number.int.positive
    $count?: boolean
    $sort?: SortControlDto
    $select?: SelectControlDto | string[]
    $search?: string
    $index?: string
    $fuzzy?: string
    $vector?: string
    $threshold?: string
    $with?: WithRelationDto[]
    $actions?: boolean
}

export interface PagesControlsDto {
    @expect.pattern "^\d+$", "u", "Expected positive number"
    $page?: string
    @expect.pattern "^\d+$", "u", "Expected positive number"
    $size?: string
    $sort?: SortControlDto
    $select?: SelectControlDto | string[]
    $search?: string
    $index?: string
    $fuzzy?: string
    $vector?: string
    $threshold?: string
    $with?: WithRelationDto[]
    $actions?: boolean
}

export interface GetOneControlsDto {
    $select?: SelectControlDto | string[]
    $with?: WithRelationDto[]
    $actions?: boolean
}

// `/geo` (since 0.1.143 — validated like `/query`). `$center` / `$maxDistance` /
// `$minDistance` are parsed by the handler first (distances arrive as numbers).
// Property order is the `crud.geo` control list order.
export interface GeoControlsDto {
    $center?: string | string[] | number[]
    $maxDistance?: number
    $minDistance?: number
    $index?: string
    $select?: SelectControlDto | string[]
    $skip?: number.int.positive
    $limit?: number.int.positive
    @expect.pattern "^\d+$", "u", "Expected positive number"
    $page?: string
    @expect.pattern "^\d+$", "u", "Expected positive number"
    $size?: string
    $with?: WithRelationDto[]
    $actions?: boolean
}

interface WithRelationDto {
    name: string
    filter?: WithFilterDto
    controls?: WithRelationControlsDto
    insights?: WithFilterDto
}

interface WithRelationControlsDto {
    $skip?: number.int.positive
    $limit?: number.int.positive
    $sort?: SortControlDto
    $select?: SelectControlDto | string[]
    $with?: WithRelationDto[]
}

interface WithFilterDto {
    [*]: string | number | boolean | null | WithFilterDto | WithFilterDto[]
}

interface SortControlDto {
    [*]: 1 | -1
}

interface SelectControlDto {
    [*]: 1 | 0
}
