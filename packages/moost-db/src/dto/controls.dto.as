export interface QueryControlsDto {
    $skip?: number.int.positive
    $limit?: number.int.positive
    $count?: boolean
    $sort?: SortControlDto
    $select?: SelectControlDto | string[]
    $search?: string
    $index?: string
    $vector?: string
    $threshold?: string
    $with?: WithRelationDto[]
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
    $vector?: string
    $threshold?: string
    $with?: WithRelationDto[]
}

export interface GetOneControlsDto {
    $select?: SelectControlDto | string[]
    $with?: WithRelationDto[]
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
